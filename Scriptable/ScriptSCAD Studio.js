// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: cube;
// © 2026 Anton Angierski · GPL-3.0-or-later · https://github.com/DarthQuintus/ScriptSCAD-Suite

// ScriptSCAD Studio – STARTER (bitte nicht ändern).
// Scriptable hält Skripte zwischengespeichert. Deshalb steht hier nur ein kleiner Starter,
// der bei jedem Start die eigentliche App frisch aus  ScriptSCAD/app/main.js  liest und ausführt.
// Updates betreffen nur den Ordner  ScriptSCAD/app  – dieses Skript bleibt gleich.
// (Texte hier bewusst fest: der Starter muss auch funktionieren, wenn der app-Ordner fehlt.)

const STARTER_VERSION = 'Starter 1';
const fm = FileManager.iCloud();
const root = fm.joinPath(fm.documentsDirectory(), 'ScriptSCAD');
const mainFile = fm.joinPath(fm.joinPath(root, 'app'), 'main.js');

async function starterAlert(message) {
  const a = new Alert();
  a.title = 'ScriptSCAD Studio';
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

try {
  if (!fm.fileExists(mainFile)) {
    await starterAlert('Datei fehlt / File missing:\niCloud Drive › Scriptable › ScriptSCAD › app › main.js\n\nBitte den Ordner ScriptSCAD vollständig kopieren.\nPlease copy the complete ScriptSCAD folder.');
  } else {
    await fm.downloadFileFromiCloud(mainFile);
    const source = fm.readString(mainFile);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('STARTER', source)({ version: STARTER_VERSION, root: root, fm: fm });
  }
} catch (e) {
  const where = e && e.line ? ' (main.js, Zeile ' + e.line + ')' : '';
  const msg = String(e) + where;
  try {
    const logFile = fm.joinPath(root, 'log.txt');
    const old = fm.fileExists(logFile) ? fm.readString(logFile) : '';
    fm.writeString(logFile, old + '[' + new Date().toISOString() + '] ' + STARTER_VERSION + ' – FEHLER: ' + msg + '\n');
  } catch (e2) { /* Protokoll ist optional */ }
  await starterAlert('Fehler beim Start / Start error:\n\n' + msg + '\n\nDetails: ScriptSCAD/log.txt');
}
Script.complete();
