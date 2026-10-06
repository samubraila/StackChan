// SPDX-License-Identifier: MIT
'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');

let mainWindow = null;

// Electron has no built-in Web Bluetooth chooser: the device list is forwarded to the
// renderer, and the renderer answers with the chosen device id (or '' to cancel).
let pendingBluetoothCallback = null;

function finishBluetoothSelection(deviceId) {
  const callback = pendingBluetoothCallback;
  pendingBluetoothCallback = null;
  if (callback) callback(deviceId);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    title: 'StackChan Desktop',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pendingBluetoothCallback = callback;
    mainWindow.webContents.send(
      'bluetooth:devices',
      devices.map((d) => ({ id: d.deviceId, name: d.deviceName || '' })),
    );
  });

  // Links (docs, GitHub) open in the default browser, never in a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    pendingBluetoothCallback = null;
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.on('bluetooth:select', (_event, deviceId) => finishBluetoothSelection(String(deviceId)));
ipcMain.on('bluetooth:cancel', () => finishBluetoothSelection(''));

app.whenReady().then(() => {
  // StackChan uses "just works" pairing. Confirm it if Windows asks; PIN pairing is not used.
  session.defaultSession.setBluetoothPairingHandler((details, callback) => {
    callback({ confirmed: details.pairingKind === 'confirm' });
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
