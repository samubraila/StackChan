// SPDX-License-Identifier: MIT
'use strict';

(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Limits from the firmware: hal_servo.cpp (servos), element.h / feature.h (face).
  const YAW = { min: -1280, max: 1280 };
  const PITCH = { min: 0, max: 900 };
  const SPEED = { min: 0, max: 1000 };
  const ROTATE = { min: -1000, max: 1000 };
  const FRAME_DURATION = { min: 50, max: 10000 };
  const LED_STEP_SECONDS = 0.3; // LED fade used for dance steps, as in the mobile app
  const PAD_INSET = 20; // keep in sync with .pad-knob in styles.css

  const DANCE_STORAGE_KEY = 'stackchan.dances.v1';
  const SSID_STORAGE_KEY = 'stackchan.wifi.ssid';

  /* ------------------------------------------------------------------------ */
  /* State                                                                    */
  /* ------------------------------------------------------------------------ */

  const feature = (values = {}) => ({ x: 0, y: 0, rotation: 0, weight: 100, size: 0, ...values });
  const defaultAvatar = () => ({ leftEye: feature(), rightEye: feature(), mouth: feature({ weight: 0 }) });

  const state = {
    avatar: defaultAvatar(),
    yaw: { angle: 0, speed: 500, rotate: 0 },
    pitch: { angle: 0, speed: 500 },
    leds: { left: '#000000', right: '#000000', fadeMs: 300 },
  };

  const link = new window.StackChanLink();
  let currentView = 'head';

  /* ------------------------------------------------------------------------ */
  /* Sending                                                                  */
  /* ------------------------------------------------------------------------ */

  let lastSendErrorAt = 0;

  function transmit(kind, payload) {
    if (!link.has(kind)) return;
    link.send(kind, payload).catch((error) => {
      if (!link.connected || Date.now() - lastSendErrorAt < 4000) return;
      lastSendErrorAt = Date.now();
      toast(`Senden fehlgeschlagen: ${error.message}`);
    });
  }

  // Payload shapes match app/lib/model/expression_data.dart.
  function sendMotion() {
    transmit('motion', {
      type: 'bleMotion',
      yawServo: { angle: state.yaw.angle, speed: state.yaw.speed },
      pitchServo: { angle: state.pitch.angle, speed: state.pitch.speed },
    });
  }

  function sendRotation() {
    transmit('motion', { type: 'bleMotion', yawServo: { rotate: state.yaw.rotate } });
  }

  function sendAvatar() {
    const { leftEye, rightEye, mouth } = state.avatar;
    transmit('avatar', { type: 'bleAvatar', leftEye, rightEye, mouth });
  }

  function sendLeds(fadeSeconds = state.leds.fadeMs / 1000) {
    transmit('rgb', {
      leftRgbColor: state.leds.left,
      leftRgbDuration: fadeSeconds,
      rightRgbColor: state.leds.right,
      rightRgbDuration: fadeSeconds,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Rendering                                                                */
  /* ------------------------------------------------------------------------ */

  const degreeFormat = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const formatTenths = (tenths) => `${degreeFormat.format(tenths / 10)}°`;
  const formatSigned = (value) => (value > 0 ? `+${value}` : String(value));

  const faceCanvas = $('#face');
  const head = $('#head');
  const padKnob = $('#pad-knob');
  const sliderBindings = [];
  let renderQueued = false;

  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderNow();
    });
  }

  function renderNow() {
    window.StackChanFace.drawFace(faceCanvas, state.avatar);

    // Exaggerated less than the real servos so the face stays readable in the preview.
    head.style.setProperty('--turn', `${(state.yaw.angle / 10) * 0.3}deg`);
    head.style.setProperty('--tilt', `${(state.pitch.angle / 10) * 0.4}deg`);
    $('#pose-yaw').textContent = formatTenths(state.yaw.angle);
    $('#pose-pitch').textContent = formatTenths(state.pitch.angle);
    $('#spin-badge').hidden = state.yaw.rotate === 0;

    padKnob.style.setProperty('--fx', (state.yaw.angle - YAW.min) / (YAW.max - YAW.min));
    padKnob.style.setProperty('--fy', 1 - (state.pitch.angle - PITCH.min) / (PITCH.max - PITCH.min));

    paintLeds($('#led-left'), state.leds.left);
    paintLeds($('#led-right'), state.leds.right);
    $('#led-left-color').value = state.leds.left.toLowerCase();
    $('#led-right-color').value = state.leds.right.toLowerCase();

    for (const binding of sliderBindings) {
      const value = binding.get();
      binding.input.value = value;
      binding.output.textContent = binding.format(value);
    }
  }

  function paintLeds(strip, color) {
    const lit = color !== '#000000';
    for (const led of strip.children) {
      led.style.setProperty('--led', lit ? color : '#1b1b1b');
      led.style.setProperty('--led-glow', lit ? color : 'transparent');
    }
  }

  let sliderSeq = 0;

  function addSlider(container, { label, min, max, step = 1, get, set, format = String }) {
    const id = `slider-${++sliderSeq}`;
    const row = document.createElement('div');
    row.className = 'slider';
    const labelEl = document.createElement('label');
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min, max, step });
    const output = document.createElement('output');
    output.htmlFor = id;
    row.append(labelEl, input, output);
    container.append(row);

    input.addEventListener('input', () => set(Number(input.value)));
    sliderBindings.push({ input, output, get, format });
  }

  /* ------------------------------------------------------------------------ */
  /* Navigation                                                               */
  /* ------------------------------------------------------------------------ */

  function showView(view) {
    currentView = view;
    for (const item of $$('.nav-item')) {
      if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== view;
    $('.panels').scrollTop = 0;
    updateModeHint();
    requestAnimationFrame(drawThumbnails);
  }

  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => showView(item.dataset.view));
  }

  /* ------------------------------------------------------------------------ */
  /* Head                                                                     */
  /* ------------------------------------------------------------------------ */

  // Each script step cancels the one before, so quick moves and dances never fight.
  let activeRun = 0;

  function cancelRuns() {
    activeRun++;
    setPlayingUi(false);
  }

  function setPose(yaw, pitch) {
    state.yaw.angle = Math.round(clamp(yaw, YAW.min, YAW.max));
    state.yaw.rotate = 0;
    state.pitch.angle = Math.round(clamp(pitch, PITCH.min, PITCH.max));
    render();
    sendMotion();
  }

  const pad = $('#pad');

  function poseFromPointer(event) {
    const rect = pad.getBoundingClientRect();
    const fx = clamp((event.clientX - rect.left - PAD_INSET) / (rect.width - 2 * PAD_INSET), 0, 1);
    const fy = clamp((event.clientY - rect.top - PAD_INSET) / (rect.height - 2 * PAD_INSET), 0, 1);
    const yaw = Math.round((YAW.min + fx * (YAW.max - YAW.min)) / 10) * 10;
    const pitch = Math.round((PITCH.max - fy * (PITCH.max - PITCH.min)) / 10) * 10;
    setPose(yaw, pitch);
  }

  pad.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    cancelRuns();
    pad.setPointerCapture(event.pointerId);
    pad.focus();
    poseFromPointer(event);
  });
  pad.addEventListener('pointermove', (event) => {
    if (pad.hasPointerCapture(event.pointerId)) poseFromPointer(event);
  });

  document.addEventListener('keydown', (event) => {
    if (currentView !== 'head' || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof Element && event.target.closest('input, select, textarea, dialog')) return;
    const yawStep = event.shiftKey ? 320 : 80;
    const pitchStep = event.shiftKey ? 225 : 50;
    const { angle: yaw } = state.yaw;
    const { angle: pitch } = state.pitch;
    const targets = {
      ArrowLeft: [yaw - yawStep, pitch],
      ArrowRight: [yaw + yawStep, pitch],
      ArrowUp: [yaw, pitch + pitchStep],
      ArrowDown: [yaw, pitch - pitchStep],
      Home: [0, 0],
    };
    const pose = targets[event.key];
    if (!pose) return;
    event.preventDefault();
    cancelRuns();
    setPose(...pose);
  });

  // [yaw, pitch, wait ms]; null keeps the current value.
  const QUICK_MOVES = {
    center: [[0, 0, 0]],
    nod: [[null, 300, 350], [null, 40, 350], [null, 300, 350], [null, 40, 350], [null, 150, 0]],
    shake: [[-320, null, 320], [320, null, 320], [-320, null, 320], [320, null, 320], [0, null, 0]],
    look: [[600, 150, 1300], [-600, 150, 1700], [0, 400, 1100], [0, 0, 0]],
  };

  async function runQuickMove(name) {
    cancelRuns();
    const run = activeRun;
    for (const [yaw, pitch, wait] of QUICK_MOVES[name]) {
      if (run !== activeRun) return;
      setPose(yaw ?? state.yaw.angle, pitch ?? state.pitch.angle);
      await sleep(wait);
    }
  }

  for (const button of $$('[data-move]')) {
    button.addEventListener('click', () => runQuickMove(button.dataset.move));
  }

  const motionSliders = $('#motion-sliders');
  addSlider(motionSliders, {
    label: 'Drehung', min: YAW.min, max: YAW.max, step: 10, format: formatTenths,
    get: () => state.yaw.angle,
    set: (v) => setPose(v, state.pitch.angle),
  });
  addSlider(motionSliders, {
    label: 'Neigung', min: PITCH.min, max: PITCH.max, step: 10, format: formatTenths,
    get: () => state.pitch.angle,
    set: (v) => setPose(state.yaw.angle, v),
  });
  addSlider(motionSliders, {
    label: 'Tempo Drehen', min: SPEED.min, max: SPEED.max, step: 10,
    get: () => state.yaw.speed,
    set: (v) => { state.yaw.speed = v; render(); },
  });
  addSlider(motionSliders, {
    label: 'Tempo Neigen', min: SPEED.min, max: SPEED.max, step: 10,
    get: () => state.pitch.speed,
    set: (v) => { state.pitch.speed = v; render(); },
  });

  addSlider($('#rotate-sliders'), {
    label: 'Geschwindigkeit', min: ROTATE.min, max: ROTATE.max, step: 10, format: formatSigned,
    get: () => state.yaw.rotate,
    set: (v) => { state.yaw.rotate = v; render(); sendRotation(); },
  });
  $('#rotate-stop').addEventListener('click', () => {
    state.yaw.rotate = 0;
    render();
    sendRotation();
  });

  /* ------------------------------------------------------------------------ */
  /* Face                                                                     */
  /* ------------------------------------------------------------------------ */

  // Eye styles follow DefaultEyes::setEmotion in the firmware; the right eye mirrors rotation.
  const EXPRESSIONS = [
    { name: 'Neutral', eyes: { weight: 100 }, mouth: { weight: 0 } },
    { name: 'Fröhlich', eyes: { weight: 72, rotation: 1550 }, mouth: { weight: 45 } },
    { name: 'Wütend', eyes: { weight: 70, rotation: 450 }, mouth: { weight: 0 } },
    { name: 'Traurig', eyes: { weight: 70, rotation: -400 }, mouth: { weight: 0, y: 15 } },
    { name: 'Skeptisch', eyes: { weight: 75 }, mouth: { weight: 0, rotation: -120 } },
    { name: 'Müde', eyes: { weight: 35, rotation: -50 }, mouth: { weight: 0 } },
    { name: 'Überrascht', eyes: { weight: 100, size: 50 }, mouth: { weight: 75 } },
    { name: 'Zwinkern', eyes: { weight: 100 }, leftEye: { weight: 0 }, mouth: { weight: 30 } },
    { name: 'Schlafen', eyes: { weight: 0 }, mouth: { weight: 0 } },
  ];

  function expressionAvatar(preset) {
    const eyes = preset.eyes || {};
    return {
      leftEye: feature({ ...eyes, ...preset.leftEye }),
      rightEye: feature({ ...eyes, rotation: -(eyes.rotation || 0), ...preset.rightEye }),
      mouth: feature({ weight: 0, ...preset.mouth }),
    };
  }

  const presetGrid = $('#expression-presets');
  for (const preset of EXPRESSIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    const canvas = document.createElement('canvas');
    canvas.dataset.thumb = 'expression';
    canvas.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = preset.name;
    button.append(canvas, label);
    button.addEventListener('click', () => {
      state.avatar = expressionAvatar(preset);
      render();
      sendAvatar();
    });
    canvas.thumbAvatar = expressionAvatar(preset);
    presetGrid.append(button);
  }

  const mirrorEyes = $('#mirror-eyes');

  function setFeature(part, key, value) {
    state.avatar[part][key] = value;
    if (part !== 'mouth' && mirrorEyes.checked) {
      const other = part === 'leftEye' ? 'rightEye' : 'leftEye';
      state.avatar[other][key] = key === 'rotation' ? -value : value;
    }
    render();
    sendAvatar();
  }

  function addFeatureSliders(container, part, withSize) {
    const sliders = [
      { key: 'x', label: 'Horizontal', min: -100, max: 100, format: formatSigned },
      { key: 'y', label: 'Vertikal', min: -100, max: 100, format: formatSigned },
      { key: 'rotation', label: 'Drehung', min: -1800, max: 1800, step: 10, format: formatTenths },
      { key: 'weight', label: 'Öffnung', min: 0, max: 100, format: (v) => `${v} %` },
    ];
    if (withSize) sliders.push({ key: 'size', label: 'Größe', min: -100, max: 100, format: formatSigned });
    for (const { key, ...options } of sliders) {
      addSlider(container, {
        ...options,
        get: () => state.avatar[part][key],
        set: (v) => setFeature(part, key, v),
      });
    }
  }

  addFeatureSliders($('#left-eye-sliders'), 'leftEye', true);
  addFeatureSliders($('#right-eye-sliders'), 'rightEye', true);
  addFeatureSliders($('#mouth-sliders'), 'mouth', false);

  /* ------------------------------------------------------------------------ */
  /* Lights                                                                   */
  /* ------------------------------------------------------------------------ */

  const SWATCHES = [
    ['Aus', '#000000'], ['Weiß', '#FFFFFF'], ['Rot', '#FF2D2D'], ['Orange', '#FF8A00'],
    ['Gelb', '#FFD60A'], ['Grün', '#30D158'], ['Türkis', '#40E0D0'], ['Blau', '#0A84FF'],
    ['Lila', '#BF5AF2'], ['Pink', '#FF5FA2'],
  ];

  const ledsLinked = $('#leds-linked');
  const rainbowToggle = $('#led-rainbow');
  const normalizeColor = (value) => (/^#[0-9a-f]{6}$/i.test(value ?? '') ? value.toUpperCase() : '#000000');

  function setLeds(left, right) {
    state.leds.left = normalizeColor(left);
    state.leds.right = normalizeColor(right);
    render();
    sendLeds();
  }

  $('#led-left-color').addEventListener('input', (event) => {
    setRainbow(false);
    setLeds(event.target.value, ledsLinked.checked ? event.target.value : state.leds.right);
  });
  $('#led-right-color').addEventListener('input', (event) => {
    setRainbow(false);
    setLeds(ledsLinked.checked ? event.target.value : state.leds.left, event.target.value);
  });
  ledsLinked.addEventListener('change', () => {
    if (ledsLinked.checked) setLeds(state.leds.left, state.leds.left);
  });

  const swatchRow = $('#swatches');
  for (const [name, color] of SWATCHES) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.title = name;
    swatch.setAttribute('aria-label', `${name} (beide Seiten)`);
    swatch.style.setProperty('--swatch', color);
    swatch.addEventListener('click', () => {
      setRainbow(false);
      setLeds(color, color);
    });
    swatchRow.append(swatch);
  }

  addSlider($('#led-sliders'), {
    label: 'Übergang', min: 0, max: 2000, step: 50,
    format: (v) => `${degreeFormat.format(v / 1000)} s`,
    get: () => state.leds.fadeMs,
    set: (v) => { state.leds.fadeMs = v; render(); },
  });

  $('#led-off').addEventListener('click', () => {
    setRainbow(false);
    setLeds('#000000', '#000000');
  });

  function hslToHex(h, s, l) {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const channel = (n) => {
      const k = (n + h / 30) % 12;
      const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(value * 255).toString(16).padStart(2, '0');
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
  }

  let rainbowTimer = null;
  let rainbowHue = 0;

  function setRainbow(on) {
    rainbowToggle.checked = on;
    clearInterval(rainbowTimer);
    rainbowTimer = null;
    if (!on) return;
    rainbowTimer = setInterval(() => {
      rainbowHue = (rainbowHue + 18) % 360;
      state.leds.left = hslToHex(rainbowHue, 100, 50);
      state.leds.right = ledsLinked.checked ? state.leds.left : hslToHex((rainbowHue + 180) % 360, 100, 50);
      render();
      sendLeds(LED_STEP_SECONDS);
    }, 300);
  }

  rainbowToggle.addEventListener('change', () => setRainbow(rainbowToggle.checked));

  /* ------------------------------------------------------------------------ */
  /* Dance                                                                    */
  /* ------------------------------------------------------------------------ */

  // A step uses the DanceData JSON of the mobile app (app/lib/model/dance_list.dart),
  // so exported files stay readable by it.
  function step(yaw, pitch, durationMs, options = {}) {
    const eyes = options.eyes || {};
    return {
      leftEye: feature({ ...eyes }),
      rightEye: feature({ ...eyes, rotation: -(eyes.rotation || 0) }),
      mouth: feature({ weight: 0, ...options.mouth }),
      yawServo: { angle: yaw, speed: options.speed ?? 400 },
      pitchServo: { angle: pitch, speed: options.speed ?? 400 },
      leftRgbColor: options.left ?? '#000000',
      rightRgbColor: options.right ?? options.left ?? '#000000',
      durationMs,
    };
  }

  const HAPPY_EYES = { weight: 72, rotation: 1550 };
  const BUILTIN_DANCES = [
    {
      id: 'builtin:happy',
      name: 'Fröhlich wippen',
      frames: [
        step(0, 100, 500, { left: '#FF8A00' }),
        step(300, 150, 800, { eyes: { ...HAPPY_EYES, x: -10 }, mouth: { weight: 50 }, left: '#FFD60A', right: '#FF8A00', speed: 300 }),
        step(-300, 150, 800, { eyes: { ...HAPPY_EYES, x: 10 }, mouth: { weight: 50 }, left: '#FF8A00', right: '#FFD60A', speed: 300 }),
        step(300, 150, 800, { eyes: { ...HAPPY_EYES, x: -10 }, mouth: { weight: 50 }, left: '#FFD60A', right: '#FF8A00', speed: 300 }),
        step(-300, 150, 800, { eyes: { ...HAPPY_EYES, x: 10 }, mouth: { weight: 50 }, left: '#FF8A00', right: '#FFD60A', speed: 300 }),
        step(0, 100, 600, { left: '#FF8A00' }),
      ],
    },
    {
      id: 'builtin:nod',
      name: 'Ja-Nicken',
      frames: [
        step(0, 300, 350, { eyes: HAPPY_EYES, mouth: { weight: 30 }, left: '#30D158', speed: 700 }),
        step(0, 40, 350, { eyes: HAPPY_EYES, mouth: { weight: 30 }, left: '#30D158', speed: 700 }),
        step(0, 300, 350, { eyes: HAPPY_EYES, mouth: { weight: 30 }, left: '#30D158', speed: 700 }),
        step(0, 40, 350, { eyes: HAPPY_EYES, mouth: { weight: 30 }, left: '#30D158', speed: 700 }),
        step(0, 120, 500),
      ],
    },
    {
      id: 'builtin:robot',
      name: 'Roboter',
      frames: [
        step(0, 100, 500, { left: '#40E0D0', speed: 800 }),
        step(450, 100, 400, { left: '#40E0D0', right: '#0A84FF', speed: 800 }),
        step(450, 300, 400, { left: '#0A84FF', right: '#40E0D0', speed: 800 }),
        step(-450, 300, 600, { left: '#40E0D0', right: '#0A84FF', speed: 800 }),
        step(-450, 100, 400, { left: '#0A84FF', right: '#40E0D0', speed: 800 }),
        step(0, 100, 400, { left: '#40E0D0', speed: 800 }),
      ],
    },
    {
      id: 'builtin:panic',
      name: 'Panik',
      frames: [
        step(0, 100, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, left: '#FF2D2D', speed: 1000 }),
        step(200, 160, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, speed: 1000 }),
        step(-200, 60, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, left: '#FF2D2D', speed: 1000 }),
        step(200, 160, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, speed: 1000 }),
        step(-200, 60, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, left: '#FF2D2D', speed: 1000 }),
        step(200, 160, 120, { eyes: { size: 40 }, mouth: { weight: 100 }, speed: 1000 }),
        step(0, 100, 600, { speed: 300 }),
      ],
    },
    {
      id: 'builtin:look',
      name: 'Umschauen',
      frames: [
        step(0, 100, 1000),
        step(600, 100, 2000, { eyes: { x: -20 }, mouth: { weight: 20 }, speed: 150 }),
        step(-600, 100, 2000, { eyes: { x: 20 }, mouth: { weight: 20 }, speed: 150 }),
        step(0, 400, 1500, { eyes: { y: -20 }, mouth: { weight: 40 }, speed: 150 }),
        step(0, 100, 1000),
      ],
    },
  ];

  const toInt = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(clamp(number, min, max)) : fallback;
  };

  function sanitizeFeature(raw, fallbackWeight) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      x: toInt(source.x, -100, 100, 0),
      y: toInt(source.y, -100, 100, 0),
      rotation: toInt(source.rotation, -3600, 3600, 0),
      weight: toInt(source.weight, 0, 100, fallbackWeight),
      size: toInt(source.size, -100, 100, 0),
    };
  }

  function sanitizeFrame(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      leftEye: sanitizeFeature(raw.leftEye, 100),
      rightEye: sanitizeFeature(raw.rightEye, 100),
      mouth: sanitizeFeature(raw.mouth, 0),
      yawServo: {
        angle: toInt(raw.yawServo?.angle, YAW.min, YAW.max, 0),
        speed: toInt(raw.yawServo?.speed, SPEED.min, SPEED.max, 500),
      },
      pitchServo: {
        angle: toInt(raw.pitchServo?.angle, PITCH.min, PITCH.max, 0),
        speed: toInt(raw.pitchServo?.speed, SPEED.min, SPEED.max, 500),
      },
      leftRgbColor: normalizeColor(raw.leftRgbColor),
      rightRgbColor: normalizeColor(raw.rightRgbColor),
      durationMs: toInt(raw.durationMs, FRAME_DURATION.min, FRAME_DURATION.max, 800),
    };
  }

  function sanitizeFrames(list) {
    return Array.isArray(list) ? list.slice(0, 500).map(sanitizeFrame).filter(Boolean) : [];
  }

  function loadLibrary() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DANCE_STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((d) => d && typeof d.id === 'string')
        .map((d) => ({ id: d.id, name: String(d.name || 'Ohne Namen'), frames: sanitizeFrames(d.frames) }));
    } catch {
      return [];
    }
  }

  function storeLibrary(list) {
    try {
      localStorage.setItem(DANCE_STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch {
      toast('Speichern nicht möglich.');
      return false;
    }
  }

  let library = loadLibrary();
  let dance = { id: null, name: '', frames: [] };

  const danceSelect = $('#dance-select');
  const danceName = $('#dance-name');
  const framesList = $('#frames');
  const frameDuration = $('#frame-duration');
  const playButton = $('#dance-play');
  const loopToggle = $('#dance-loop');

  function refreshDanceSelect() {
    danceSelect.replaceChildren();
    if (!dance.id) danceSelect.append(new Option('– Neuer Tanz –', ''));
    const groups = [
      ['Beispiele', BUILTIN_DANCES],
      ['Meine Tänze', library],
    ];
    for (const [label, dances] of groups) {
      if (dances.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const d of dances) group.append(new Option(d.name, d.id));
      danceSelect.append(group);
    }
    danceSelect.value = dance.id ?? '';
    $('#dance-delete').disabled = !library.some((d) => d.id === dance.id);
  }

  function loadDance(source) {
    cancelRuns();
    dance = { id: source.id, name: source.name, frames: source.frames.map((f) => structuredClone(f)) };
    danceName.value = dance.name;
    refreshDanceSelect();
    renderFrames();
  }

  function describeFrame(frame) {
    return `<span>Drehung <b>${formatTenths(frame.yawServo.angle)}</b> · Neigung <b>${formatTenths(frame.pitchServo.angle)}</b></span>`;
  }

  function iconButton(text, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn icon';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  function renderFrames() {
    framesList.replaceChildren();
    dance.frames.forEach((frame, index) => {
      const item = document.createElement('li');
      item.className = 'frame';

      const number = document.createElement('span');
      number.className = 'frame-index';
      number.textContent = index + 1;

      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'frame-thumb';
      thumb.title = 'Pose anzeigen';
      thumb.setAttribute('aria-label', `Schritt ${index + 1} anzeigen`);
      const canvas = document.createElement('canvas');
      canvas.dataset.thumb = 'frame';
      canvas.thumbAvatar = frame;
      thumb.append(canvas);
      thumb.addEventListener('click', () => {
        cancelRuns();
        applyFrame(frame, LED_STEP_SECONDS);
      });

      const info = document.createElement('div');
      info.className = 'frame-info';
      info.innerHTML = describeFrame(frame);
      const leds = document.createElement('span');
      leds.className = 'frame-leds';
      leds.append('LEDs');
      for (const color of [frame.leftRgbColor, frame.rightRgbColor]) {
        const dot = document.createElement('i');
        dot.style.setProperty('--led', color);
        leds.append(dot);
      }
      info.append(leds);

      const duration = document.createElement('input');
      Object.assign(duration, { type: 'number', min: FRAME_DURATION.min, max: FRAME_DURATION.max, step: 50 });
      duration.value = frame.durationMs;
      duration.title = 'Dauer in Millisekunden';
      duration.setAttribute('aria-label', `Dauer von Schritt ${index + 1} in Millisekunden`);
      duration.addEventListener('change', () => {
        frame.durationMs = toInt(duration.value, FRAME_DURATION.min, FRAME_DURATION.max, frame.durationMs);
        duration.value = frame.durationMs;
      });

      const tools = document.createElement('div');
      tools.className = 'frame-tools';
      tools.append(
        iconButton('↑', 'Nach oben', () => moveFrame(index, -1)),
        iconButton('↓', 'Nach unten', () => moveFrame(index, 1)),
        iconButton('⟳', 'Mit aktueller Pose ersetzen', () => {
          dance.frames[index] = captureFrame(frame.durationMs);
          renderFrames();
        }),
        iconButton('✕', 'Schritt löschen', () => {
          dance.frames.splice(index, 1);
          renderFrames();
        }),
      );

      item.append(number, thumb, info, duration, tools);
      framesList.append(item);
    });

    $('#frame-count').textContent = dance.frames.length;
    $('#frames-empty').hidden = dance.frames.length > 0;
    playButton.disabled = dance.frames.length === 0;
    requestAnimationFrame(drawThumbnails);
  }

  function moveFrame(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= dance.frames.length) return;
    [dance.frames[index], dance.frames[target]] = [dance.frames[target], dance.frames[index]];
    renderFrames();
  }

  function captureFrame(durationMs) {
    return sanitizeFrame({
      ...structuredClone(state.avatar),
      yawServo: { angle: state.yaw.angle, speed: state.yaw.speed },
      pitchServo: { angle: state.pitch.angle, speed: state.pitch.speed },
      leftRgbColor: state.leds.left,
      rightRgbColor: state.leds.right,
      durationMs,
    });
  }

  function applyFrame(frame, ledFadeSeconds) {
    state.avatar = structuredClone({ leftEye: frame.leftEye, rightEye: frame.rightEye, mouth: frame.mouth });
    state.yaw.angle = frame.yawServo.angle;
    state.yaw.speed = frame.yawServo.speed;
    state.yaw.rotate = 0;
    state.pitch.angle = frame.pitchServo.angle;
    state.pitch.speed = frame.pitchServo.speed;
    state.leds.left = frame.leftRgbColor;
    state.leds.right = frame.rightRgbColor;
    render();
    sendMotion();
    sendAvatar();
    sendLeds(ledFadeSeconds);
  }

  function setPlayingUi(playing) {
    playButton.textContent = playing ? '■ Stopp' : '▶ Abspielen';
    playButton.dataset.playing = playing ? 'true' : '';
    if (!playing) highlightFrame(-1);
  }

  function highlightFrame(index) {
    $$('.frame', framesList).forEach((item, i) => item.classList.toggle('playing', i === index));
  }

  async function playDance() {
    cancelRuns();
    setRainbow(false);
    const run = activeRun;
    setPlayingUi(true);
    do {
      for (let index = 0; index < dance.frames.length; index++) {
        if (run !== activeRun) return;
        const frame = dance.frames[index];
        highlightFrame(index);
        applyFrame(frame, LED_STEP_SECONDS);
        // Same pacing as the mobile app: step duration plus a small gap for the BLE writes.
        await sleep(frame.durationMs + 70);
      }
    } while (loopToggle.checked && run === activeRun && dance.frames.length > 0);
    if (run === activeRun) setPlayingUi(false);
  }

  playButton.addEventListener('click', () => {
    if (playButton.dataset.playing) cancelRuns();
    else playDance();
  });

  $('#frame-add').addEventListener('click', () => {
    const durationMs = toInt(frameDuration.value, FRAME_DURATION.min, FRAME_DURATION.max, 800);
    frameDuration.value = durationMs;
    dance.frames.push(captureFrame(durationMs));
    renderFrames();
    framesList.lastElementChild?.scrollIntoView({ block: 'nearest' });
  });

  danceSelect.addEventListener('change', () => {
    const source = [...BUILTIN_DANCES, ...library].find((d) => d.id === danceSelect.value);
    if (source) loadDance(source);
  });

  danceName.addEventListener('input', () => {
    dance.name = danceName.value;
  });

  $('#dance-new').addEventListener('click', () => {
    loadDance({ id: null, name: '', frames: [] });
    danceName.focus();
  });

  $('#dance-save').addEventListener('click', () => {
    if (dance.frames.length === 0) {
      toast('Füge zuerst mindestens einen Schritt hinzu.');
      return;
    }
    const name = danceName.value.trim() || 'Mein Tanz';
    const existing = library.find((d) => d.id === dance.id);
    const entry = { id: existing ? existing.id : crypto.randomUUID(), name, frames: structuredClone(dance.frames) };
    const next = existing ? library.map((d) => (d.id === entry.id ? entry : d)) : [...library, entry];
    if (!storeLibrary(next)) return;
    library = next;
    dance.id = entry.id;
    dance.name = name;
    danceName.value = name;
    refreshDanceSelect();
    toast(`„${name}“ gespeichert.`);
  });

  $('#dance-delete').addEventListener('click', () => {
    const entry = library.find((d) => d.id === dance.id);
    if (!entry || !confirm(`„${entry.name}“ wirklich löschen?`)) return;
    const next = library.filter((d) => d.id !== entry.id);
    if (!storeLibrary(next)) return;
    library = next;
    loadDance({ id: null, name: '', frames: [] });
    toast(`„${entry.name}“ gelöscht.`);
  });

  $('#dance-export').addEventListener('click', () => {
    if (dance.frames.length === 0) {
      toast('Der Tanz hat noch keine Schritte.');
      return;
    }
    const name = danceName.value.trim() || 'Tanz';
    const blob = new Blob([JSON.stringify({ danceName: name, danceData: dance.frames }, null, 2)], {
      type: 'application/json',
    });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 10000);
  });

  const danceFile = $('#dance-file');
  $('#dance-import').addEventListener('click', () => danceFile.click());
  danceFile.addEventListener('change', async () => {
    const file = danceFile.files?.[0];
    danceFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // Accepts this app's export, the mobile app's DanceList JSON, or a bare list of steps.
      const rawFrames = Array.isArray(data) ? data : data?.danceData ?? data?.frames;
      const frames = sanitizeFrames(rawFrames);
      if (frames.length === 0) throw new Error('Keine Schritte gefunden.');
      const name = String((Array.isArray(data) ? '' : data.danceName ?? data.name) || file.name.replace(/\.json$/i, ''));
      loadDance({ id: null, name, frames });
      toast(`„${name}“ importiert (${frames.length} Schritte). Zum Behalten speichern.`);
    } catch (error) {
      toast(`Import fehlgeschlagen: ${error.message}`);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Wi-Fi                                                                    */
  /* ------------------------------------------------------------------------ */

  const wifiState = $('#wifi-state');
  const wifiSsid = $('#wifi-ssid');
  const wifiPassword = $('#wifi-password');

  try {
    wifiSsid.value = localStorage.getItem(SSID_STORAGE_KEY) || '';
  } catch {
    // Storage unavailable; start empty.
  }

  function setWifiState(text, tone = '') {
    wifiState.textContent = text;
    wifiState.dataset.tone = tone;
  }

  function wifiReady() {
    if (!link.has('config')) {
      setWifiState('Nicht verbunden. Bitte zuerst links mit StackChan verbinden.', 'bad');
      return false;
    }
    if (link.mode !== 'setup') {
      setWifiState('StackChan ist nicht im Einrichtungsmodus. Öffne am Roboter die App SETUP und verbinde dich neu.', 'warn');
      return false;
    }
    return true;
  }

  $('#wifi-toggle').addEventListener('click', (event) => {
    const show = wifiPassword.type === 'password';
    wifiPassword.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? 'Verbergen' : 'Anzeigen';
  });

  $('#wifi-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ssid = wifiSsid.value.trim();
    if (!ssid || !wifiReady()) return;
    try {
      localStorage.setItem(SSID_STORAGE_KEY, ssid);
    } catch {
      // Remembering the SSID is optional.
    }
    setWifiState('Sende Zugangsdaten…', 'warn');
    try {
      await link.send('config', { cmd: 'setWifi', data: { ssid, password: wifiPassword.value } }, { coalesce: false });
      setWifiState('Gesendet. StackChan verbindet sich…', 'warn');
    } catch (error) {
      setWifiState(`Senden fehlgeschlagen: ${error.message}`, 'bad');
    }
  });

  $('#wifi-status').addEventListener('click', () => {
    if (!wifiReady()) return;
    link.send('config', { cmd: 'getWifiStatus' }, { coalesce: false }).catch((error) => {
      setWifiState(`Abfrage fehlgeschlagen: ${error.message}`, 'bad');
    });
  });

  // Notifications from WifiConfigServer::notify_state in the firmware.
  link.addEventListener('config', (event) => {
    const message = event.detail.json;
    if (message?.cmd !== 'notifyState') return;
    const { type, state: detail = '' } = message.data || {};
    switch (type) {
      case 0: setWifiState('StackChan verbindet sich mit dem WLAN…', 'warn'); break;
      case 1: setWifiState('StackChan ist mit dem WLAN verbunden.', 'good'); break;
      case 2:
        setWifiState(
          detail.includes('Busy')
            ? 'StackChan ist noch mit einem Verbindungsversuch beschäftigt. Bitte kurz warten.'
            : 'Verbindung fehlgeschlagen. Bitte Name und Passwort prüfen.',
          'bad',
        );
        break;
      case 3: setWifiState('StackChan ist mit keinem WLAN verbunden.', ''); break;
      default: break;
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Connection                                                               */
  /* ------------------------------------------------------------------------ */

  const connectButton = $('#connect-btn');
  const picker = $('#picker');
  const deviceList = $('#device-list');
  const pickerHint = $('#picker-hint');
  let pickerSelected = false;
  let pickerCancelled = false;

  function openPicker() {
    pickerSelected = false;
    pickerCancelled = false;
    deviceList.replaceChildren();
    pickerHint.textContent = 'Suche nach StackChan in der Nähe…';
    picker.showModal();
  }

  window.desktop?.onBluetoothDevices((devices) => {
    if (!picker.open) return;
    deviceList.replaceChildren();
    for (const device of devices) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('span');
      name.textContent = device.name || 'Unbekanntes Gerät';
      const id = document.createElement('small');
      id.textContent = device.id;
      button.append(name, id);
      button.addEventListener('click', () => {
        pickerSelected = true;
        window.desktop.selectBluetoothDevice(device.id);
        picker.close();
      });
      item.append(button);
      deviceList.append(item);
    }
    pickerHint.textContent = devices.length
      ? 'Wähle deinen StackChan aus:'
      : 'Suche nach StackChan in der Nähe…';
  });

  picker.addEventListener('close', () => {
    if (pickerSelected) return;
    pickerCancelled = true;
    window.desktop?.cancelBluetoothRequest();
  });
  $('#picker-cancel').addEventListener('click', () => picker.close());

  function connectErrorMessage(error) {
    const text = String(error?.message || '');
    switch (error?.name) {
      case 'NotFoundError':
        return /adapter|globally disabled/i.test(text)
          ? 'Bluetooth ist ausgeschaltet oder nicht verfügbar.'
          : 'Kein StackChan gefunden. Ist am Roboter die App DANCE oder SETUP geöffnet?';
      case 'NetworkError':
        return 'Verbindung fehlgeschlagen. Ist StackChan in der Nähe und nicht mit dem Handy verbunden?';
      case 'SecurityError':
        return 'Der Zugriff auf Bluetooth wurde verweigert.';
      default:
        return text || 'Verbindung fehlgeschlagen.';
    }
  }

  connectButton.addEventListener('click', async () => {
    if (link.status === 'connected' || link.status === 'reconnecting') {
      await link.disconnect();
      toast('Verbindung getrennt.');
      return;
    }
    if (!(await window.StackChanLink.isAvailable())) {
      toast('Bluetooth ist ausgeschaltet oder an diesem PC nicht verfügbar.');
      return;
    }
    openPicker();
    try {
      await link.connect();
      toast(`Verbunden mit ${link.deviceName}.`);
    } catch (error) {
      if (!pickerCancelled) toast(connectErrorMessage(error));
    } finally {
      if (picker.open) {
        pickerSelected = true; // the request is already finished; nothing to cancel
        picker.close();
      }
    }
  });

  const STATUS_TEXT = {
    disconnected: ['Nicht verbunden', 'Vorschau-Modus: Änderungen werden nur hier angezeigt.'],
    connecting: ['Verbinde…', 'Bitte warten.'],
    reconnecting: ['Verbindung unterbrochen', 'Verbinde erneut…'],
  };

  function updateConnectionUi() {
    const { status } = link;
    $('#conn-dot').dataset.status = status;
    if (status === 'connected') {
      $('#conn-label').textContent = link.deviceName;
      $('#conn-detail').textContent =
        link.mode === 'setup' ? 'Einrichtungsmodus (App SETUP)' : 'Steuermodus (App DANCE)';
    } else {
      [$('#conn-label').textContent, $('#conn-detail').textContent] = STATUS_TEXT[status];
    }
    connectButton.disabled = status === 'connecting';
    connectButton.textContent =
      status === 'connecting' ? 'Verbinde…' : status === 'disconnected' ? 'Verbinden' : 'Trennen';
    connectButton.classList.toggle('primary', status === 'disconnected' || status === 'connecting');
    updateModeHint();
  }

  function updateModeHint() {
    const hint = $('#mode-hint');
    let text = '';
    if (link.connected && link.mode === 'setup' && currentView !== 'wifi' && currentView !== 'help') {
      text = 'StackChan ist im Einrichtungsmodus und reagiert hier nicht. Öffne am Roboter die App DANCE und verbinde dich neu.';
    } else if (link.connected && link.mode === 'control' && currentView === 'wifi') {
      text = 'StackChan ist im Steuermodus (App DANCE). Für die WLAN-Einrichtung öffne am Roboter die App SETUP und verbinde dich neu.';
    }
    hint.textContent = text;
    hint.hidden = !text;
  }

  link.addEventListener('status', () => {
    updateConnectionUi();
    if (link.connected && link.mode === 'control') {
      // Show the face and lights from the preview on the robot; the head only moves on request.
      sendAvatar();
      sendLeds();
    }
    if (link.status === 'disconnected') setRainbow(false);
  });
  link.addEventListener('log', (event) => toast(event.detail.message));

  window.addEventListener('beforeunload', () => {
    link.disconnect();
  });

  /* ------------------------------------------------------------------------ */
  /* Toast & thumbnails                                                       */
  /* ------------------------------------------------------------------------ */

  const toastEl = $('#toast');
  let toastTimer = null;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  function drawThumbnails() {
    for (const canvas of $$('canvas[data-thumb]')) {
      if (canvas.thumbAvatar && canvas.offsetParent !== null) {
        window.StackChanFace.drawFace(canvas, canvas.thumbAvatar);
      }
    }
  }

  new ResizeObserver(() => render()).observe(faceCanvas);
  window.addEventListener('resize', () => requestAnimationFrame(drawThumbnails));

  /* ------------------------------------------------------------------------ */
  /* Start                                                                    */
  /* ------------------------------------------------------------------------ */

  refreshDanceSelect();
  renderFrames();
  updateConnectionUi();
  renderNow();
})();
