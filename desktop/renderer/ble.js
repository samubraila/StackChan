// SPDX-License-Identifier: MIT
// Web Bluetooth link to a StackChan robot.
// Protocol mirrors firmware/main/hal/hal_ble.cpp and app/lib/util/blue_util.dart:
// each characteristic takes one UTF-8 JSON document per write.
'use strict';

(function () {
  // Service used by the DANCE app on the robot (live control of head, face, LEDs).
  const SERVICE_CONTROL = 'e2e5e5e0-1234-5678-1234-56789abcdef0';
  // Service used by the SETUP app on the robot (Wi-Fi provisioning).
  const SERVICE_SETUP = 'e2e5e5ff-1234-5678-1234-56789abcdef0';

  const CHARACTERISTICS = {
    motion: 'e2e5e5e1-1234-5678-1234-56789abcdef0',
    avatar: 'e2e5e5e2-1234-5678-1234-56789abcdef0',
    config: 'e2e5e5e3-1234-5678-1234-56789abcdef0',
    rgb: 'e2e5e5e4-1234-5678-1234-56789abcdef0',
  };

  // Fragment frame understood by the firmware's BleFragmentAssembler:
  // AA 55 C3 01 | index (u16 BE) | total packets (u16 BE) | total length (u16 BE) | payload
  const FRAME_MAGIC = [0xaa, 0x55, 0xc3, 0x01];
  const FRAME_HEADER_LEN = 10;
  const MIN_ATT_PAYLOAD = 20;
  const MAX_JSON_LEN = 2048;

  const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function isFragmentFrame(bytes) {
    return (
      bytes.length > FRAME_HEADER_LEN &&
      FRAME_MAGIC.every((value, index) => bytes[index] === value)
    );
  }

  function buildFragments(bytes, packetSize) {
    if (bytes.length <= packetSize) return [bytes];
    const chunk = packetSize - FRAME_HEADER_LEN;
    const total = Math.ceil(bytes.length / chunk);
    const packets = [];
    for (let index = 0; index < total; index++) {
      const part = bytes.subarray(index * chunk, (index + 1) * chunk);
      const packet = new Uint8Array(FRAME_HEADER_LEN + part.length);
      packet.set(FRAME_MAGIC, 0);
      packet[4] = index >> 8;
      packet[5] = index & 0xff;
      packet[6] = total >> 8;
      packet[7] = total & 0xff;
      packet[8] = bytes.length >> 8;
      packet[9] = bytes.length & 0xff;
      packet.set(part, FRAME_HEADER_LEN);
      packets.push(packet);
    }
    return packets;
  }

  class StackChanLink extends EventTarget {
    constructor() {
      super();
      this.device = null;
      this.mode = null; // 'control' | 'setup'
      this.characteristics = {};
      this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
      this._jobs = [];
      this._pumping = false;
      this._useFragments = false;
      this._userDisconnect = false;
      this._assembly = null;
      this._onDisconnected = this._onDisconnected.bind(this);
      this._onConfigNotify = this._onConfigNotify.bind(this);
    }

    get connected() {
      return this.status === 'connected';
    }

    get deviceName() {
      return this.device?.name || 'StackChan';
    }

    has(kind) {
      return this.connected && Boolean(this.characteristics[kind]);
    }

    static async isAvailable() {
      if (!navigator.bluetooth) return false;
      try {
        return await navigator.bluetooth.getAvailability();
      } catch {
        return false;
      }
    }

    async connect() {
      if (!navigator.bluetooth) {
        throw new Error('Bluetooth wird in dieser Umgebung nicht unterstützt.');
      }
      if (this.device) await this.disconnect();

      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [SERVICE_CONTROL] },
          { services: [SERVICE_SETUP] },
          { namePrefix: 'StackChan' },
        ],
        optionalServices: [SERVICE_CONTROL, SERVICE_SETUP],
      });

      this.device = device;
      this._userDisconnect = false;
      this._useFragments = false;
      device.addEventListener('gattserverdisconnected', this._onDisconnected);
      this._setStatus('connecting');
      try {
        await this._setupGatt();
      } catch (error) {
        this._userDisconnect = true;
        if (device.gatt.connected) device.gatt.disconnect();
        this._forget();
        throw error;
      }
    }

    async disconnect() {
      this._userDisconnect = true;
      const device = this.device;
      this._forget();
      if (device?.gatt.connected) device.gatt.disconnect();
    }

    /**
     * Queue a JSON document for a characteristic. Writes run one at a time (Web Bluetooth
     * rejects overlapping GATT operations). With `coalesce`, a newer document for the same
     * characteristic replaces one that is still waiting, so slider drags never pile up.
     */
    send(kind, payload, { coalesce = true } = {}) {
      if (!this.has(kind)) return Promise.resolve(false);
      const bytes = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (bytes.length > MAX_JSON_LEN) return Promise.reject(new Error('Datenpaket zu groß.'));

      return new Promise((resolve, reject) => {
        const waiting = coalesce && this._jobs.find((job) => job.kind === kind && job.coalesce);
        if (waiting) {
          waiting.bytes = bytes;
          waiting.waiters.push({ resolve, reject });
        } else {
          this._jobs.push({ kind, bytes, coalesce, waiters: [{ resolve, reject }] });
        }
        this._pump();
      });
    }

    async _pump() {
      if (this._pumping) return;
      this._pumping = true;
      try {
        while (this._jobs.length > 0) {
          const job = this._jobs.shift();
          const characteristic = this.characteristics[job.kind];
          try {
            if (!characteristic || !this.connected) throw new Error('Nicht verbunden.');
            await this._write(characteristic, job.bytes);
            job.waiters.forEach((w) => w.resolve(true));
          } catch (error) {
            job.waiters.forEach((w) => w.reject(error));
          }
        }
      } finally {
        this._pumping = false;
      }
    }

    async _write(characteristic, bytes) {
      if (!this._useFragments) {
        try {
          await this._rawWrite(characteristic, bytes);
          return;
        } catch (error) {
          // A long write can fail on some adapters; the firmware also accepts fragment frames.
          if (bytes.length <= MIN_ATT_PAYLOAD || !this.connected) throw error;
          this._useFragments = true;
          this._log('Lange Schreibzugriffe nicht möglich – sende fragmentiert.');
        }
      }
      for (const packet of buildFragments(bytes, MIN_ATT_PAYLOAD)) {
        await this._rawWrite(characteristic, packet);
      }
    }

    _rawWrite(characteristic, bytes) {
      if (characteristic.properties.write) return characteristic.writeValueWithResponse(bytes);
      return characteristic.writeValueWithoutResponse(bytes);
    }

    async _setupGatt() {
      const server = await this.device.gatt.connect();

      let service = null;
      for (const [uuid, mode] of [
        [SERVICE_CONTROL, 'control'],
        [SERVICE_SETUP, 'setup'],
      ]) {
        try {
          service = await server.getPrimaryService(uuid);
          this.mode = mode;
          break;
        } catch {
          // Try the next service; the robot only exposes one at a time.
        }
      }
      if (!service) {
        throw new Error('Auf dem Gerät wurde kein StackChan-Dienst gefunden.');
      }

      this.characteristics.config?.removeEventListener('characteristicvaluechanged', this._onConfigNotify);
      this.characteristics = {};
      for (const [kind, uuid] of Object.entries(CHARACTERISTICS)) {
        try {
          this.characteristics[kind] = await service.getCharacteristic(uuid);
        } catch {
          // Missing characteristics are reported through has(kind).
        }
      }

      const config = this.characteristics.config;
      if (config && (config.properties.notify || config.properties.indicate)) {
        config.addEventListener('characteristicvaluechanged', this._onConfigNotify);
        try {
          await config.startNotifications();
        } catch (error) {
          this._log(`Benachrichtigungen nicht verfügbar: ${error.message}`);
        }
      }

      this._setStatus('connected');
    }

    _onConfigNotify(event) {
      const view = event.target.value;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = this._reassemble(bytes);
      if (text === null) return;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Keep the raw text for the log.
      }
      this.dispatchEvent(new CustomEvent('config', { detail: { text, json } }));
    }

    _reassemble(bytes) {
      if (!isFragmentFrame(bytes)) {
        this._assembly = null;
        return decoder.decode(bytes);
      }
      const index = (bytes[4] << 8) | bytes[5];
      const total = (bytes[6] << 8) | bytes[7];
      const length = (bytes[8] << 8) | bytes[9];
      if (index === 0) this._assembly = { total, length, next: 0, parts: [] };
      const assembly = this._assembly;
      if (!assembly || index !== assembly.next || total !== assembly.total) {
        this._assembly = null;
        return null;
      }
      assembly.parts.push(bytes.subarray(FRAME_HEADER_LEN));
      assembly.next++;
      if (assembly.next < assembly.total) return null;
      this._assembly = null;
      const joined = new Uint8Array(assembly.parts.reduce((sum, p) => sum + p.length, 0));
      let offset = 0;
      for (const part of assembly.parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      return decoder.decode(joined.subarray(0, assembly.length));
    }

    async _onDisconnected() {
      this._failPendingJobs();
      if (this._userDisconnect || !this.device) {
        this._forget();
        return;
      }

      // Unexpected drop (robot switched apps, went out of range): try to come back quietly.
      this._setStatus('reconnecting');
      for (const delay of RECONNECT_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        if (this._userDisconnect || !this.device) return;
        try {
          await this._setupGatt();
          this._log('Verbindung wiederhergestellt.');
          return;
        } catch {
          // Next attempt.
        }
      }
      this._log('Verbindung verloren.');
      this._forget();
    }

    _failPendingJobs() {
      const jobs = this._jobs;
      this._jobs = [];
      const error = new Error('Verbindung getrennt.');
      jobs.forEach((job) => job.waiters.forEach((w) => w.reject(error)));
    }

    _forget() {
      this._failPendingJobs();
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
      }
      const config = this.characteristics.config;
      if (config) config.removeEventListener('characteristicvaluechanged', this._onConfigNotify);
      this.device = null;
      this.mode = null;
      this.characteristics = {};
      this._assembly = null;
      this._setStatus('disconnected');
    }

    _setStatus(status) {
      if (this.status === status) return;
      this.status = status;
      this.dispatchEvent(new CustomEvent('status', { detail: { status } }));
    }

    _log(message) {
      this.dispatchEvent(new CustomEvent('log', { detail: { message } }));
    }
  }

  window.StackChanLink = StackChanLink;
})();
