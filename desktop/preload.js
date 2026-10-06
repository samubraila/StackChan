// SPDX-License-Identifier: MIT
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** Called each time the Bluetooth scan finds devices; returns an unsubscribe function. */
  onBluetoothDevices(callback) {
    const listener = (_event, devices) => callback(devices);
    ipcRenderer.on('bluetooth:devices', listener);
    return () => ipcRenderer.removeListener('bluetooth:devices', listener);
  },
  selectBluetoothDevice(deviceId) {
    ipcRenderer.send('bluetooth:select', deviceId);
  },
  cancelBluetoothRequest() {
    ipcRenderer.send('bluetooth:cancel');
  },
});
