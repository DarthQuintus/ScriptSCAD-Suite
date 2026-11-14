// ScriptSCAD Slicer – Hauptprogramm (Scriptable-Seite).
// Wird vom Starter „ScriptSCAD Slicer.js“ bei jedem Start frisch gelesen und ausgeführt (STARTER = { version, root, fm }).
// Gleiche Regeln wie Studio (PLAN.md → Schritt 1): evaluateJavaScript endet mit „null“, Ergebnisse per completion(Text),
// Aktionen der Seite per Abfrage, Timer statt setTimeout, WASM als base64 in 256-KB-Stücken.
// 9i: Aus Studio gestartet (STARTER.open = Projektkennung) → Druckplatte bzw. STL dieses Projekts sofort öffnen.
// 9e.3: Projektordner mit Namen (app/projekte.js), Druckplatten in projects/<Name>/platte.json. 9g: Profile (slicer/profile.json), G-Code-Import. 9h: Web Worker.
// 9e: Druckplatte mit mehreren Objekten; STL aus der Dateien-App (Kopie in slicer/stl/).
// 9a: STL aus Studio (projects/<id>/export/*.stl) mit CuraEngine slicen, G-Code speichern/teilen. 9b: Studio-Layout, 3D-Vorschau, Zeitachse.

const VERSION = '10o.2'; // bei jeder Lieferung erhöhen
const CHUNK = 262144;
const GCODE_CHUNK = 524288;
const LOG_MAX_LINES = 600;
const APP_FILES = ['slicer.html', 'slicer.js', 'slicer-core.js', 'slicer-settings.js', 'slicer-import.js', 'slicer-i18n.js', 'projekte.js', 'vctl.js', 'ui-common.js', 'about.js', 'style.css', 'slicer/curaengine.js', 'slicer/curaengine.wasm', 'slicer/viewer.js',
  'slicer/definitions/fdmprinter.def.json', 'slicer/definitions/fdmextruder.def.json', 'slicer/standard.json', 'slicer/drucker.json',
  'fonts/SpaceGrotesk-400.woff2', 'fonts/SpaceGrotesk-500.woff2', 'fonts/SpaceGrotesk-700.woff2', 'fonts/JetBrainsMono-400.woff2', 'fonts/JetBrainsMono-600.woff2'];

const fm = STARTER.fm;
const root = STARTER.root;
const appDir = fm.joinPath(root, 'app');
const projectsDir = fm.joinPath(root, 'projects');
const slicerDir = fm.joinPath(root, 'slicer'); // G-Code des Testwürfels, einstellungen.json (9c)
const userSettingsFile = fm.joinPath(slicerDir, 'einstellungen.json');
const importDir = fm.joinPath(slicerDir, 'stl'); // aus der Dateien-App übernommene STL (9e)
const platesDir = fm.joinPath(slicerDir, 'platten'); // Druckplatten aus 9e.1/9e.2 (werden beim Start in Projektordner umgezogen)
const profilesFile = fm.joinPath(slicerDir, 'profile.json'); // eigene Drucker + Parameter-Profile (9g)
const settingsFile = fm.joinPath(root, 'settings.json');
const logFile = fm.joinPath(root, 'slicer-log.txt');
const t0 = Date.now();

// ---------- Protokoll ----------
let oldLog = [];
try { if (fm.fileExists(logFile)) oldLog = fm.readString(logFile).split('\n').filter((l) => l); } catch (e) { /* egal */ }
const logLines = [];
function step(msg) {
  const line = '[' + ((Date.now() - t0) / 1000).toFixed(2) + ' s] ' + msg;
  logLines.push(line);
  console.log(line);
  try {
    const all = oldLog.concat(['', '=== ' + new Date(t0).toISOString() + ' · Slicer ' + VERSION + ' ==='], logLines);
    fm.writeString(logFile, all.slice(-LOG_MAX_LINES).join('\n') + '\n');
  } catch (e) { /* Protokoll darf nichts stoppen */ }
}

// ---------- Hilfen ----------
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v ? v[k] : ''));
const js = (v) => JSON.stringify(v);
async function readText(path) { await fm.downloadFileFromiCloud(path); return fm.readString(path); }
function timeout(ms, what) {
  return new Promise((_, reject) => Timer.schedule(ms, false, () => reject(new Error('Zeitüberschreitung (' + Math.round(ms / 1000) + ' s): ' + what))));
}
function sleep(ms) { return new Promise((resolve) => Timer.schedule(ms, false, resolve)); }
let signalClosed;
const viewClosed = new Promise((_, reject) => { signalClosed = reject; });
viewClosed.catch(() => {});
function run(wv, code, useCallback, ms, what) {
  const list = [wv.evaluateJavaScript(code + ';\nnull;', !!useCallback), viewClosed];
  if (ms) list.push(timeout(ms, what || code.slice(0, 40)));
  return Promise.race(list);
}
function readSettings() {
  try { if (fm.fileExists(settingsFile)) return JSON.parse(fm.readString(settingsFile)) || {}; } catch (e) { /* egal */ }
  return {};
}
function sysLang() {
  let first = '';
  try { const pl = Device.preferredLanguages(); first = String((pl && pl[0]) || ''); } catch (e) { /* egal */ }
  return /^de/i.test(first) ? 'de' : 'en';
}
function safeFileName(n) { return String(n || 'Modell').replace(/[\/\\:*?"<>|]+/g, '_').trim() || 'Modell'; }

const I18N_ALL = new Function('var window = {};\n' + (await readText(fm.joinPath(appDir, 'slicer-i18n.js'))) + '\nreturn window.SLICER_I18N;')();
let LANG = readSettings().lang || sysLang();
let T = I18N_ALL[LANG] || I18N_ALL.de;

// ---------- Projektordner (9e.3): Ordner = Projektname, Kennung in project.json; gemeinsam mit Studio (app/projekte.js) ----------
let store = null; // wird nach der Dateiprüfung angelegt (siehe Ablauf)
const exists = (p) => fm.fileExists(p);
const isStudio = (dir) => exists(fm.joinPath(dir, 'model.scad'));

// ---------- Modelle: STL aus Studio (projects/<Name>/export/*.stl), importierte (slicer/stl/*.stl), Kopien in Plattenordnern (projects/<Platte>/stl/) ----------
// Quelle (src), wie sie in Druckplatten steht – unabhängig vom Ordnernamen:
//   „cube“ · „p:<Kennung>/export/<Datei>“ · „p:<Kennung>/stl/<Datei>“ · „slicer/stl/<Datei>“ (noch nicht gespeicherter Import)
const rel = (p) => p.slice(root.length + 1);
const MESH_RE = /\.(stl|3mf|obj)$/i; // 10j: Modelle als STL, 3MF oder OBJ
async function listModels() {
  const out = [];
  const add = (p, src, pid, projectName, f, hidden) => {
    let mod = 0;
    try { mod = fm.modificationDate(p).getTime(); } catch (e) { /* egal */ }
    out.push({ src, abs: p, pid, projectName, file: f, modified: mod, hidden: !!hidden });
  };
  if (exists(importDir)) for (const f of fm.listContents(importDir)) if (MESH_RE.test(f)) add(fm.joinPath(importDir, f), 'slicer/stl/' + f, null, T.imported, f);
  for (const [id, folder] of await store.index(true)) {
    const dir = fm.joinPath(projectsDir, folder);
    let name = folder;
    for (const [sub, hidden] of [['export', false], ['stl', true]]) {
      const d = fm.joinPath(dir, sub);
      if (!exists(d) || !fm.isDirectory(d)) continue;
      const list = fm.listContents(d).filter((f) => MESH_RE.test(f));
      if (!list.length) continue;
      let kind = '';
      if (name === folder) { try { const pj = JSON.parse(await readText(fm.joinPath(dir, 'project.json'))); name = pj.name || folder; kind = pj.kind || ''; } catch (e) { /* Name optional */ } }
      // 10n: STL des Studio-Testwürfels nicht doppelt zeigen (der Slicer hat seinen eigenen, gleichen Testwürfel)
      for (const f of list) add(fm.joinPath(d, f), 'p:' + id + '/' + sub + '/' + f, id, name, f, hidden || kind === 'test');
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}
let models = [];
// Alte Quellen („projects/<Ordner>/export/x.stl“ aus 9e.1/9e.2) auf die neue Schreibweise bringen
async function normSrc(src) {
  const m = /^projects\/([^/]+)\/(.+)$/.exec(String(src));
  if (!m) return String(src);
  const idx = await store.index();
  if (idx.has(m[1])) return 'p:' + m[1] + '/' + m[2]; // alter Ordnername = Kennung
  for (const [id, folder] of idx) if (folder === m[1]) return 'p:' + id + '/' + m[2];
  return String(src);
}
// Nur Modelle aus der Liste dürfen gelesen werden
function modelBySrc(src) {
  const m = models.find((x) => x.src === src);
  if (!m) throw new Error('Modell nicht gefunden: ' + src);
  return m;
}
// ---------- Druckplatten: projects/<Name>/platte.json (auch Studio-Projekte können eine Platte haben) ----------
async function listPlates() {
  const out = [];
  for (const [id, folder] of await store.index()) {
    const dir = fm.joinPath(projectsDir, folder);
    const p = fm.joinPath(dir, 'platte.json');
    if (!exists(p)) continue;
    try {
      const d = JSON.parse(await readText(p));
      let mod = 0;
      try { mod = fm.modificationDate(p).getTime(); } catch (e) { /* egal */ }
      out.push({ id, name: String(d.name || folder), count: (d.objects || []).length, modified: mod, studio: isStudio(dir) });
    } catch (e) { step('Druckplatte nicht lesbar: ' + folder + ' (' + e + ')'); }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}
// Platte speichern → { id, name, srcs }. Ein einzelnes Studio-Objekt: platte.json im Studio-Projekt. Sonst eigener Ordner projects/<Plattenname>/
// (gleicher Name = überschreiben), importierte STL werden hineinkopiert (stl/), damit alles zur Platte in einem Ordner liegt.
async function storePlate(name, d) {
  for (const o of d.objects) o.src = await normSrc(o.src);
  const one = d.objects.length === 1 ? /^p:([^/]+)\/export\//.exec(d.objects[0].src) : null;
  let id = null, dir = null;
  if (one) { const sd = await store.dirOf(one[1]); if (sd && isStudio(sd)) { id = one[1]; dir = sd; } }
  if (!id) {
    for (const pl of await listPlates()) if (!pl.studio && pl.name.toLowerCase() === String(name).toLowerCase()) { id = pl.id; dir = await store.dirOf(id); break; }
    if (!id) { const p = await store.create(name, { kind: 'plate' }); id = p.id; dir = p.dir; }
    for (const o of d.objects) {
      if (!/^slicer\/stl\//.test(o.src)) continue;
      const f = o.src.split('/').pop();
      const from = fm.joinPath(root, o.src);
      if (!exists(from)) continue;
      const stlDir = fm.joinPath(dir, 'stl');
      if (!exists(stlDir)) fm.createDirectory(stlDir, true);
      const to = fm.joinPath(stlDir, f);
      await fm.downloadFileFromiCloud(from);
      if (exists(to)) fm.remove(to);
      fm.copy(from, to);
      o.src = 'p:' + id + '/stl/' + f;
    }
  }
  d.name = String(name);
  fm.writeString(fm.joinPath(dir, 'platte.json'), JSON.stringify(d, null, 1));
  return { id, name: d.name, srcs: d.objects.map((o) => o.src), path: rel(fm.joinPath(dir, 'platte.json')) };
}
// Einmalig: Druckplatten aus 9e.1/9e.2 (slicer/platten/*.json) in Projektordner umziehen; die alten Dateien wandern in den Papierkorb
async function migratePlates() {
  if (!exists(platesDir)) return;
  const old = fm.listContents(platesDir).filter((f) => /\.json$/i.test(f));
  if (!old.length) return;
  const keep = fm.joinPath(fm.joinPath(root, 'papierkorb'), 'platten-9e2');
  for (const f of old) {
    const p = fm.joinPath(platesDir, f);
    try {
      const d = JSON.parse(await readText(p));
      const r = await storePlate(String(d.name || f.replace(/\.json$/i, '')), d);
      if (!exists(keep)) fm.createDirectory(keep, true);
      const t = fm.joinPath(keep, f);
      if (exists(t)) fm.remove(t);
      fm.move(p, t);
      step('Druckplatte umgezogen: slicer/platten/' + f + ' → ' + r.path);
    } catch (e) { step('Druckplatte nicht umgezogen: ' + f + ' (' + e + ')'); }
  }
}
const pub = (m) => ({ path: m.src, projectName: m.projectName, file: m.file, modified: m.modified });
async function sendModels(wv) { await run(wv, 'App.setModels(' + js(js(models.filter((m) => !m.hidden).map(pub))) + ')', false, 10000, 'Modellliste'); }
async function sendPlates(wv) { await run(wv, 'App.setPlates(' + js(js(await listPlates())) + ')', false, 10000, 'Druckplatten'); }
// G-Code-Ziel: gespeicherte Platte → projects/<Ordner>/export/<Plattenname>.gcode; ein Objekt aus einem Projekt → neben der STL im Projekt;
// Testwürfel, Import und ungespeicherte Platten mit mehreren Objekten → slicer/
async function gcodeTarget(a) {
  const dirOfPid = a.pid ? await store.dirOf(a.pid) : null;
  if (dirOfPid && a.plateName) return fm.joinPath(fm.joinPath(dirOfPid, 'export'), safeFileName(a.plateName) + '.gcode');
  if (a.srcs.length === 1) {
    if (a.srcs[0] === 'cube') return fm.joinPath(slicerDir, 'Testwuerfel-20mm.gcode');
    const m = modelBySrc(a.srcs[0]);
    const base = safeFileName(m.file.replace(MESH_RE, ''));
    const d = m.pid ? await store.dirOf(m.pid) : null;
    if (d) return fm.joinPath(fm.joinPath(d, 'export'), base + '.gcode');
    return fm.joinPath(slicerDir, base + '.gcode');
  }
  return fm.joinPath(slicerDir, (a.plateName ? safeFileName(a.plateName) : 'Druckplatte') + '.gcode');
}
let lastGcodePath = null;

async function sendBase64(wv, name, b64, isClosed) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - pad;
  await run(wv, 'App.fileBegin(' + js(name) + ',' + bytes + ')', false, 10000, 'Übertragung ' + name);
  for (let i = 0, n = 1; i < b64.length; i += CHUNK, n++) {
    if (isClosed()) throw new Error('Ansicht wurde geschlossen');
    await run(wv, 'App.fileAdd(' + js(name) + ',"' + b64.slice(i, i + CHUNK) + '")', false, 15000, name + ' Stück ' + n);
  }
  return bytes;
}

async function handle(wv, a, isClosed) {
  switch (a.type) {
    case 'addModel': {
      try {
        if (a.src === 'cube') {
          await run(wv, 'App.modelLoaded(' + js(js({ name: a.name || T.testCube, src: 'cube', cube: true, key: a.key, pos: a.pos })) + ')', false, 10000, 'Testwürfel');
          return;
        }
        const src = await normSrc(a.src);
        const m = modelBySrc(src);
        const p = m.abs;
        await fm.downloadFileFromiCloud(p);
        const t = Date.now();
        const bytes = await sendBase64(wv, 'model', Data.fromFile(p).toBase64String(), isClosed);
        step('STL übertragen: ' + rel(p) + ' (' + Math.round(bytes / 1024) + ' KB, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s)');
        const base = m.file.replace(MESH_RE, '');
        const name = a.name || (m.pid && m.projectName !== base ? m.projectName + ' · ' + base : base);
        await run(wv, 'App.modelLoaded(' + js(js({ name, src, cube: false, key: a.key, pos: a.pos })) + ')', false, 15000, 'Modell');
      } catch (e) {
        if (isClosed()) throw e;
        step('Modell nicht ladbar: ' + a.src + ' (' + e + ')');
        await run(wv, 'App.modelFailed(' + js(js({ key: a.key, name: String(a.src).split('/').pop(), msg: String(e.message || e) })) + ')', false, 5000);
      }
      return;
    }
    case 'pickFiles': {
      // STL aus der Dateien-App: Kopie nach slicer/stl/ (so bleibt sie für gespeicherte Druckplatten erreichbar)
      let paths;
      try { paths = await DocumentPicker.open(); } catch (e) { step('Dateien: abgebrochen (' + e + ')'); return; }
      const added = [];
      for (const p of paths || []) {
        const f = String(p).split('/').pop();
        if (!MESH_RE.test(f)) { await run(wv, 'App.toast(' + js(fmt(T.notStl, { name: f })) + ')'); continue; }
        if (!fm.fileExists(importDir)) fm.createDirectory(importDir, true);
        const target = fm.joinPath(importDir, safeFileName(f));
        const data = Data.fromFile(p);
        if (!data) { await run(wv, 'App.toast(' + js(fmt(T.modelFailed, { name: f, msg: '?' })) + ')'); continue; }
        if (fm.fileExists(target)) fm.remove(target);
        fm.write(target, data);
        step('STL übernommen: ' + f + ' → ' + rel(target));
        added.push('slicer/stl/' + safeFileName(f));
      }
      if (!added.length) return;
      models = await listModels();
      await sendModels(wv);
      for (const src of added) await run(wv, 'App.addModel(' + js(src) + ')', false, 5000, 'Modell hinzufügen');
      return;
    }
    case 'savePlate': {
      const d = JSON.parse(a.data); // nur gültiges JSON speichern
      const r = await storePlate(a.name, d);
      step('Druckplatte gespeichert: ' + r.path + ' (' + d.objects.length + ' Objekte)');
      models = await listModels();
      await sendModels(wv);
      await sendPlates(wv);
      await run(wv, 'App.plateSaved(' + js(js({ name: r.name, pid: r.id, srcs: r.srcs })) + ')', false, 5000);
      return;
    }
    case 'loadPlate': {
      const dir = await store.dirOf(a.id);
      if (!dir) throw new Error('Druckplatte nicht gefunden: ' + a.id);
      const d = JSON.parse(await readText(fm.joinPath(dir, 'platte.json')));
      const objects = [];
      for (const o of d.objects || []) objects.push({ src: await normSrc(o.src), name: o.name, x: o.x, y: o.y, rot: o.rot, scale: o.scale, pre: o.pre });
      step('Druckplatte geladen: ' + rel(dir) + '/platte.json (' + objects.length + ' Objekte)');
      await run(wv, 'App.plateData(' + js(js({ name: d.name, pid: a.id, objects })) + ')', false, 10000, 'Druckplatte');
      return;
    }
    case 'deletePlate': {
      const dir = await store.dirOf(a.id);
      if (!dir) return;
      if (isStudio(dir)) {
        // Studio-Projekt: nur die Platte entfernen, Projekt und G-Code bleiben
        fm.remove(fm.joinPath(dir, 'platte.json'));
        step('Druckplatte gelöscht: ' + rel(dir) + '/platte.json');
      } else {
        // reines Slicer-Projekt: ganzer Ordner in den Papierkorb (wiederherstellbar)
        const trash = fm.joinPath(root, 'papierkorb');
        if (!exists(trash)) fm.createDirectory(trash, true);
        const folder = dir.split('/').pop();
        let target = fm.joinPath(trash, folder);
        if (exists(target)) target = fm.joinPath(trash, folder + '-' + Date.now());
        fm.move(dir, target);
        await store.remove(a.id);
        step('Druckplatte in Papierkorb: ' + folder);
      }
      models = await listModels();
      await sendModels(wv);
      await sendPlates(wv);
      return;
    }
    case 'saveProfiles': {
      const data = JSON.parse(a.data); // nur gültiges JSON speichern
      if (!exists(slicerDir)) fm.createDirectory(slicerDir, true);
      fm.writeString(profilesFile, JSON.stringify(data, null, 1));
      step('Profile gespeichert: ' + Object.keys(data.params || {}).length + ' Parameter-Profile, ' + (data.printers || []).length + ' eigene Drucker');
      return;
    }
    case 'importGcode': {
      // G-Code einer anderen Slicer-App: Einstellungen stehen am Anfang und/oder Ende der Datei → nur diese Teile an die Seite geben
      let paths;
      try { paths = await DocumentPicker.open(); } catch (e) { step('G-Code-Import: abgebrochen (' + e + ')'); return; }
      const p = (paths || [])[0];
      if (!p) return;
      const f = String(p).split('/').pop();
      let text = null;
      try { text = fm.readString(p); } catch (e) { /* unten: zweiter Versuch */ }
      if (text == null) { const d = Data.fromFile(p); text = d ? d.toRawString() : null; }
      if (text == null) { await run(wv, 'App.toast(' + js(fmt(T.importUnreadable, { name: f })) + ')'); step('G-Code-Import: nicht lesbar: ' + f); return; }
      const total = text.length;
      if (total > 1500000) text = text.slice(0, 400000) + '\n' + text.slice(-900000);
      await sendBase64(wv, 'import', Data.fromString(text).toBase64String(), isClosed);
      step('G-Code-Import: ' + f + ' (' + Math.round(total / 1024) + ' KB)');
      await run(wv, 'App.gcodeImport(' + js(js({ name: f })) + ')', false, 15000, 'G-Code-Import');
      return;
    }
    case 'gcodeReady': {
      // G-Code in Stücken abholen (lange Texte über completion vermeiden) und speichern
      const t = Date.now();
      const parts = [];
      for (let i = 0; i < a.chunks; i++) {
        if (isClosed()) throw new Error('Ansicht wurde geschlossen');
        parts.push(await run(wv, 'completion(App.gcodeChunk(' + i + ',' + GCODE_CHUNK + '))', true, 15000, 'G-Code Stück ' + (i + 1)));
      }
      const text = parts.join('');
      if (text.length !== a.length) throw new Error('G-Code unvollständig: ' + text.length + '/' + a.length);
      currentTarget = await gcodeTarget(a);
      const dir = currentTarget.slice(0, currentTarget.lastIndexOf('/'));
      if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
      if (fm.fileExists(currentTarget)) fm.remove(currentTarget);
      fm.writeString(currentTarget, text);
      lastGcodePath = currentTarget;
      step('G-Code gespeichert: ' + currentTarget.slice(root.length + 1) + ' (' + Math.round(text.length / 1024) + ' KB, ' + a.chunks + ' Stücke, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s) · ' + a.summary);
      await run(wv, 'App.gcodeSaved(' + js(js({ path: currentTarget.slice(root.length + 1) })) + ')', false, 10000, 'G-Code bestätigen');
      return;
    }
    case 'share': {
      if (!lastGcodePath) return;
      step('Teilen-Menü: ' + lastGcodePath);
      try { const r = await ShareSheet.present([lastGcodePath]); step('Teilen geschlossen: ' + js(r)); } catch (e) {
        step('FEHLER Teilen: ' + e);
        await run(wv, 'App.toast(' + js(fmt(T.shareFailed, { msg: String(e.message || e) })) + ')');
      }
      return;
    }
    case 'saveToFiles': {
      if (!lastGcodePath) return;
      try { const r = await DocumentPicker.export(lastGcodePath); step('In Dateien gesichert: ' + js(r)); if (r && r.length) await run(wv, 'App.toast(' + js(T.savedToFiles) + ')'); } catch (e) {
        step('In Dateien sichern abgebrochen/fehlgeschlagen: ' + e);
      }
      return;
    }
    case 'saveSettings': {
      const data = JSON.parse(a.data); // nur gültiges JSON speichern
      if (!fm.fileExists(slicerDir)) fm.createDirectory(slicerDir, true);
      fm.writeString(userSettingsFile, JSON.stringify(data, null, 1));
      step('Einstellungen gespeichert: ' + data.printer + ', ' + data.material);
      return;
    }
    case 'exportProfiles': {
      // 10e: eigene Drucker + Parameter-Profile als eine Datei → Teilen-Menü (Datei bleibt in slicer/export/)
      const d = JSON.parse(a.data);
      const dir = fm.joinPath(slicerDir, 'export');
      if (!exists(dir)) fm.createDirectory(dir, true);
      const file = 'ScriptSCAD-Profile.json';
      const path = fm.joinPath(dir, file);
      if (exists(path)) fm.remove(path);
      fm.writeString(path, JSON.stringify(d, null, 1));
      step('Profile exportiert: ' + (d.printers || []).length + ' Drucker, ' + Object.keys(d.params || {}).length + ' Profile → slicer/export/' + file);
      await run(wv, 'App.toast(' + js(fmt(T.profExported, { file: 'slicer/export/' + file })) + ')');
      try { const r = await ShareSheet.present([path]); step('Teilen geschlossen: ' + js(r)); } catch (e) { step('FEHLER Teilen: ' + e); }
      return;
    }
    case 'netKey': {
      const k = String(a.key || '').trim();
      if (k) Keychain.set(NET_KEY, k); else if (Keychain.contains(NET_KEY)) Keychain.remove(NET_KEY);
      step('Netzwerk-Drucker: API-Schlüssel ' + (k ? 'gespeichert (Schlüsselbund)' : 'entfernt'));
      return;
    }
    case 'netTest': {
      let r;
      try { r = { ok: true, info: await netTest(a.net || {}) }; } catch (e) { r = { ok: false, msg: String(e.message || e) }; }
      step('Netzwerk-Drucker testen (' + (a.net && a.net.type) + ', ' + (a.net && a.net.url) + '): ' + (r.ok ? r.info : 'FEHLGESCHLAGEN ' + r.msg));
      await run(wv, 'App.netResult(' + js(js(r)) + ')', false, 5000);
      return;
    }
    case 'netSend': {
      let r;
      if (!lastGcodePath) return;
      try { const name = await netSend(a.net || {}, lastGcodePath, !!a.print); r = { ok: true, upload: true, info: name + (a.print ? ' – ' + T.netPrinting : ' – ' + T.netUploaded) }; } catch (e) { r = { ok: false, upload: true, msg: String(e.message || e) }; }
      step('Netzwerk-Drucker senden (' + (a.net && a.net.type) + (a.print ? ', drucken' : ', nur hochladen') + '): ' + (r.ok ? r.info : 'FEHLGESCHLAGEN ' + r.msg));
      await run(wv, 'App.netResult(' + js(js(r)) + ')', false, 5000);
      return;
    }
    case 'commonSettings': {
      // 10d: Sprache/Darstellung in ScriptSCAD/settings.json (dieselbe Datei wie Studio; andere Werte bleiben)
      const st = readSettings();
      if (a.lang != null) { if (a.lang === 'de' || a.lang === 'en') st.lang = a.lang; else delete st.lang; LANG = st.lang || sysLang(); T = I18N_ALL[LANG] || I18N_ALL.de; }
      if (['system', 'light', 'dark'].includes(a.theme)) st.theme = a.theme;
      fm.writeString(settingsFile, JSON.stringify(st, null, 1));
      step('Einstellungen (gemeinsam): Sprache ' + (st.lang || 'automatisch → ' + LANG) + ', Darstellung ' + (st.theme || 'system'));
      return;
    }
    case 'log': step('Seite: ' + a.msg); return;
    default: step('Unbekannte Aktion: ' + js(a));
  }
}
let currentTarget = null;
// ---------- 10m: Drucker im Netzwerk (OctoPrint, Moonraker/Klipper, PrusaLink) – API-Schlüssel im iOS-Schlüsselbund ----------
const NET_KEY = 'scriptscad.slicer.netkey';
function netKey() { try { return Keychain.contains(NET_KEY) ? Keychain.get(NET_KEY) : ''; } catch (e) { return ''; } }
function netBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error(T.netNoUrl || 'Adresse fehlt');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}
function netRequest(url, key, method) {
  const rq = new Request(url);
  rq.method = method || 'GET';
  rq.timeoutInterval = 20;
  rq.headers = key ? { 'X-Api-Key': key } : {};
  return rq;
}
async function netCall(rq, asJson) {
  const d = await rq.load();
  const code = rq.response && rq.response.statusCode;
  let text = '';
  try { text = d.toRawString() || ''; } catch (e) { /* binär */ }
  if (!code || code < 200 || code >= 300) {
    const hint = code === 401 || code === 403 ? ' – API-Schlüssel prüfen' : '';
    throw new Error('HTTP ' + code + hint + (text ? ': ' + text.slice(0, 120) : ''));
  }
  return asJson ? (text ? JSON.parse(text) : {}) : text;
}
async function netTest(net) {
  const base = netBase(net.url), key = netKey();
  if (net.type === 'octoprint') { const d = await netCall(netRequest(base + '/api/version', key), true); return 'OctoPrint ' + (d.server || d.text || ''); }
  if (net.type === 'moonraker') { const d = await netCall(netRequest(base + '/server/info', key), true); const r = d.result || d; return 'Klipper/Moonraker ' + (r.moonraker_version || '') + (r.klippy_state ? ' · ' + r.klippy_state : ''); }
  if (net.type === 'prusalink') { const d = await netCall(netRequest(base + '/api/version', key), true); return 'PrusaLink ' + (d.server || d.text || '') + (d.hostname ? ' · ' + d.hostname : ''); }
  throw new Error('unbekannte Verbindung');
}
async function netSend(net, path, print) {
  const base = netBase(net.url), key = netKey();
  const name = path.split('/').pop();
  const data = Data.fromFile(path);
  if (net.type === 'octoprint') {
    const rq = netRequest(base + '/api/files/local', key, 'POST');
    rq.addFileDataToMultipart(data, 'application/octet-stream', 'file', name);
    rq.addParameterToMultipart('select', print ? 'true' : 'false');
    rq.addParameterToMultipart('print', print ? 'true' : 'false');
    await netCall(rq, false);
  } else if (net.type === 'moonraker') {
    const rq = netRequest(base + '/server/files/upload', key, 'POST');
    rq.addFileDataToMultipart(data, 'application/octet-stream', 'file', name);
    rq.addParameterToMultipart('root', 'gcodes');
    if (print) rq.addParameterToMultipart('print', 'true');
    await netCall(rq, false);
  } else if (net.type === 'prusalink') {
    const rq = netRequest(base + '/api/v1/files/usb/' + encodeURIComponent(name), key, 'PUT');
    rq.headers = Object.assign(rq.headers, { 'Content-Type': 'text/x.gcode', 'Overwrite': '?1', 'Print-After-Upload': print ? '?1' : '?0' });
    rq.body = data;
    await netCall(rq, false);
  } else throw new Error('unbekannte Verbindung');
  return name;
}
// 9i: aus Studio gestartet → gespeicherte Platte im Studio-Projekt laden, sonst neue Platte mit dessen STL (export/)
async function openFromStudio(wv, pid) {
  const plate = (await listPlates()).find((p) => p.id === pid);
  const model = models.find((m) => m.pid === pid && m.src.startsWith('p:' + pid + '/export/'));
  const what = plate ? { plate: plate.id } : model ? { src: model.src } : null;
  step('Aus Studio geöffnet: ' + pid + ' → ' + (what ? js(what) : 'kein Modell gefunden'));
  if (what) await run(wv, 'App.openStart(' + js(js(what)) + ')', false, 10000, 'Modell aus Studio öffnen');
}

// ---------- Ablauf ----------
let ok = false;
try {
  step('Start Slicer ' + VERSION + ' (' + STARTER.version + '). Gerät: ' + Device.model() + ', iOS ' + Device.systemVersion() + ', Sprache ' + LANG);
  const missing = APP_FILES.filter((f) => !fm.fileExists(fm.joinPath(appDir, f)));
  if (missing.length) {
    step('Dateien fehlen: ' + missing.join(', '));
    const al = new Alert(); al.title = T.appName; al.message = fmt(T.filesMissing, { list: missing.join('\n') }); al.addAction('OK'); await al.presentAlert();
    ok = true;
    return;
  }
  for (const f of APP_FILES) await fm.downloadFileFromiCloud(fm.joinPath(appDir, f));
  store = new Function((await readText(fm.joinPath(appDir, 'projekte.js'))) + '\nreturn ProjectStore;')()(fm, root, step);
  const moved = await store.migrate(); // 9e.3: alte Ordner „p2026…“ → Projektname
  if (moved) step('Projektordner umbenannt: ' + moved);
  await migratePlates();
  models = await listModels();
  step('Modelle: ' + models.length);

  const wv = new WebView();
  await wv.loadFile(fm.joinPath(appDir, 'slicer.html'));
  const pageVersion = await run(wv, 'completion(App.version())', true, 5000, 'Version der Oberfläche');
  step('Seite geladen, Oberfläche ' + pageVersion);
  if (pageVersion !== VERSION) step('WARNUNG: Version Seite ' + pageVersion + ' ≠ ' + VERSION);
  let deviceDark = null;
  try { deviceDark = !!Device.isUsingDarkAppearance(); } catch (e) { /* ältere Scriptable-Fassung */ }
  await run(wv, 'App.init(' + js(js({ version: VERSION, lang: LANG, langSetting: readSettings().lang || '', sysLang: sysLang(), theme: readSettings().theme || 'system', deviceDark })) + ')', false, 5000, 'Start');

  let closed = false;
  const isClosed = () => closed;
  const closedPromise = wv.present(true).then(() => { closed = true; signalClosed(new Error('Ansicht wurde geschlossen')); return null; });
  await sleep(1200); // Öffnen-Animation abwarten (Schritt 1)
  await run(wv, 'App.ready().then(completion)', true, 15000, 'Oberfläche zeichnen');
  if (STARTER.result) STARTER.result.opened = true; // Studio erfährt: das Fenster ist offen
  await sendModels(wv);
  await sendPlates(wv);

  // Standardwerte, Druckerbibliothek, gespeicherte Einstellungen, Druckerdefinitionen, CuraEngine
  await run(wv, 'App.setStandard(' + js(await readText(fm.joinPath(appDir, 'slicer/standard.json'))) + ')', false, 10000, 'Standardwerte');
  await sendBase64(wv, 'library', Data.fromFile(fm.joinPath(appDir, 'slicer/drucker.json')).toBase64String(), isClosed);
  await run(wv, 'App.libraryReady()', false, 10000, 'Druckerbibliothek');
  let profiles = '';
  try { if (exists(profilesFile)) profiles = await readText(profilesFile); } catch (e) { step('profile.json nicht lesbar: ' + e); }
  await run(wv, 'App.setProfiles(' + js(profiles) + ')', false, 10000, 'Profile');
  // Quelltext der Engine: damit kann die Seite in einem Hintergrund-Prozess (Web Worker) slicen, ohne zu blockieren (9h)
  await run(wv, 'App.setEngineSource(' + js(await readText(fm.joinPath(appDir, 'slicer/curaengine.js'))) + ')', false, 15000, 'Engine-Quelltext');
  let userSettings = '';
  try { if (fm.fileExists(userSettingsFile)) userSettings = await readText(userSettingsFile); } catch (e) { step('einstellungen.json nicht lesbar: ' + e); }
  await run(wv, 'App.netKeyState(' + js(!!netKey()) + ')', false, 5000, 'Netzwerk'); // 10m
  await run(wv, 'App.setUserSettings(' + js(userSettings) + ')', false, 10000, 'Einstellungen');
  step('Einstellungen: ' + (userSettings ? 'gespeicherte geladen' : 'Standard'));
  for (const f of ['fdmprinter.def.json', 'fdmextruder.def.json']) {
    await sendBase64(wv, 'def:' + f, Data.fromFile(fm.joinPath(appDir, 'slicer/definitions/' + f)).toBase64String(), isClosed);
  }
  const t = Date.now();
  const bytes = await sendBase64(wv, 'wasm', Data.fromFile(fm.joinPath(appDir, 'slicer/curaengine.wasm')).toBase64String(), isClosed);
  step('CuraEngine übertragen: ' + bytes + ' Bytes, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s');
  const res = JSON.parse(await run(wv, 'App.engineFinish().then(completion)', true, 90000, 'CuraEngine vorbereiten'));
  step('CuraEngine: ' + js(res));
  ok = true;
  if (STARTER.open) await openFromStudio(wv, String(STARTER.open));

  // Aktionen abfragen, bis die Ansicht geschlossen wird (wie Studio: _id + ack, nichts geht verloren)
  let ack = 0, fails = 0;
  while (!closed) {
    await Promise.race([sleep(400), closedPromise]);
    if (closed) break;
    let reply;
    try { reply = JSON.parse(await run(wv, 'completion(App.poll(' + ack + '))', true, 10000, 'Abfrage')); } catch (e) {
      if (closed) break;
      fails++;
      if (fails === 1 || fails % 30 === 0) step('Abfrage ohne Antwort (' + fails + '×): ' + e);
      await Promise.race([sleep(1000), closedPromise]);
      continue;
    }
    fails = 0;
    for (const a of reply.actions) {
      if (a._id <= ack) continue;
      ack = a._id;
      try { await handle(wv, a, isClosed); } catch (e) {
        if (closed) break;
        step('FEHLER bei Aktion ' + a.type + ': ' + e);
        await run(wv, 'App.status(' + js(fmt(T.error, { msg: String(e.message || e) })) + ', true)', false, 5000).catch(() => {});
      }
    }
  }
  step('Ansicht geschlossen.');
} catch (e) {
  step('FEHLER: ' + e + (e && e.line ? ' (Zeile ' + e.line + ')' : ''));
  if (!ok) {
    const al = new Alert(); al.title = T.appName; al.message = fmt(T.error, { msg: String(e) }) + '\n\nScriptSCAD/slicer-log.txt'; al.addAction('OK'); await al.presentAlert();
  }
}
