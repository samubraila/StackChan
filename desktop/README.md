# StackChan Desktop

Windows-App, die einen M5Stack StackChan direkt per Bluetooth steuert – ohne Handy und ohne Server.

- **Kopf**: Blickrichtung per Maus-Feld, Pfeiltasten oder Reglern; Nicken, Kopfschütteln, Umschauen; Dauerdrehung
- **Gesicht**: neun Ausdrücke, Augen und Mund einzeln einstellbar, Live-Vorschau wie auf dem Display
- **Licht**: beide LED-Leisten einfärben, Übergangszeit, Regenbogen
- **Tanz**: Posen als Schritte aufnehmen, abspielen (auch in Schleife), speichern, als JSON im Format der Handy-App exportieren/importieren
- **WLAN**: Zugangsdaten an StackChan senden (Einrichtungsmodus)

Ohne Verbindung läuft alles im Vorschau-Modus.

## Starten

Fertige App: `dist/StackChan Desktop-win32-x64/StackChan Desktop.exe`

Aus dem Quellcode (Node.js 22.12 oder neuer):

```powershell
npm install
node node_modules/electron/install.js   # lädt die Electron-Laufzeit
npm start
```

Neu bauen: `npm run package`. Das Icon wird aus `build/icons/*.png` mit `npm run icon` erzeugt.

## Verbindung

1. Bluetooth am PC einschalten (Bluetooth Low Energy nötig).
2. Am StackChan die App **DANCE** öffnen – nur dort nimmt er Steuerbefehle per Bluetooth an. Für die WLAN-Einrichtung die App **SETUP**.
3. In der App auf **Verbinden** klicken und StackChan auswählen.

## Technik

Electron mit Web Bluetooth, ohne weitere Laufzeit-Abhängigkeiten. Das Protokoll entspricht der Firmware in `../firmware/main/hal/hal_ble.cpp`:

| Charakteristik | UUID | Inhalt |
| --- | --- | --- |
| Motion | `e2e5e5e1-…` | `{"type":"bleMotion","yawServo":{"angle","speed"},"pitchServo":{…}}` bzw. `{"yawServo":{"rotate"}}` |
| Avatar | `e2e5e5e2-…` | `{"type":"bleAvatar","leftEye":{x,y,rotation,weight,size},"rightEye":{…},"mouth":{…}}` |
| Config | `e2e5e5e3-…` | `{"cmd":"setWifi","data":{"ssid","password"}}`, `{"cmd":"getWifiStatus"}`; Antwort `notifyState` |
| RGB | `e2e5e5e4-…` | `{"leftRgbColor":"#RRGGBB","leftRgbDuration":0.3,"rightRgbColor":…,"rightRgbDuration":…}` |

Dienst `e2e5e5e0-…` = Steuermodus (DANCE), `e2e5e5ff-…` = Einrichtungsmodus (SETUP). Kann der PC keine langen Schreibzugriffe, sendet die App automatisch fragmentiert (Rahmen `AA 55 C3 01`, wie von der Firmware erwartet).

| Datei | Aufgabe |
| --- | --- |
| `main.js` | Fenster, Bluetooth-Geräteauswahl, Pairing |
| `preload.js` | Brücke zwischen Fenster und Hauptprozess |
| `renderer/ble.js` | Verbindung, Schreib-Warteschlange, Fragmentierung, Auto-Reconnect |
| `renderer/face.js` | Gesicht zeichnen (Geometrie aus `firmware/.../skins/default`) |
| `renderer/app.js` | Oberfläche und Logik |

Nicht enthalten sind die Cloud-Funktionen der Handy-App (KI-Gespräch, Kamera, Konto, Geräte-Bindung).
