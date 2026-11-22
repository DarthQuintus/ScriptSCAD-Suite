// ScriptSCAD Studio – Hauptprogramm (Scriptable-Seite).
// Wird vom Starter „ScriptSCAD Studio.js“ bei jedem Start frisch gelesen und ausgeführt
// (Variable STARTER = { version, root, fm }). Top-Level-await und return sind hier erlaubt.
//
// Regeln aus Schritt 1 (siehe PLAN.md → Erkenntnisse):
//  - evaluateJavaScript: Befehl endet immer mit „null“; Ergebnisse nur über completion(Text).
//  - Aktionen der Seite per Abfrage (App.poll) statt dauerhaft wartendem Aufruf.
//  - Kein setTimeout in Scriptable → Timer.
//  - WASM als base64 in 256-KB-Stücken übertragen, in der Seite einmal kompilieren.

const VERSION = '10o.2'; // bei jeder Lieferung erhöhen – steht im Protokoll und in der Kopfzeile
const CHUNK = 262144;
const LOG_MAX_LINES = 600;
const APP_FILES = ['index.html', 'style.css', 'app.js', 'vctl.js', 'ui-common.js', 'about.js', 'export.js', 'update-quelle.json', 'i18n.js', 'params.js', 'objects.js', 'projekte.js', 'beispiel.scad', 'beispiel-en.scad', 'lib/viewer.js', 'lib/editor.js', 'lib/scad-hints.js', 'lib/openscad.js', 'lib/openscad.wasm', 'bibliothek/scriptscad.scad',
  'fonts/SpaceGrotesk-400.woff2', 'fonts/SpaceGrotesk-500.woff2', 'fonts/SpaceGrotesk-700.woff2', 'fonts/JetBrainsMono-400.woff2', 'fonts/JetBrainsMono-600.woff2'];

const fm = STARTER.fm;
const root = STARTER.root;
const appDir = fm.joinPath(root, 'app');
const projectsDir = fm.joinPath(root, 'projects');
const trashDir = fm.joinPath(root, 'papierkorb');
const settingsFile = fm.joinPath(root, 'settings.json');
const aiDir = fm.joinPath(root, 'ai');
const fontsDir = fm.joinPath(root, 'fonts'); // Schriftarten für text() (7f), eigener Ordner neben app/
const libsDir = fm.joinPath(root, 'bibliotheken'); // Fremdbibliotheken BOSL2/MCAD/NopSCADlib (7g), je eine Paketdatei <Name>.json
const LIB_NAMES = ['BOSL2', 'MCAD', 'NopSCADlib'];
const SHORTCUT_NAME = 'ScriptSCAD KI';
const SHORTCUT_DONE = 'SCRIPTSCAD-FERTIG'; // Ausgabe des Kurzbefehls ab 8a.6 (Antwort steht in ai/response.txt)
const logFile = fm.joinPath(root, 'log.txt');
const t0 = Date.now();

// ---------- Protokoll (Datei bleibt erhalten, auch wenn die Ansicht abstürzt) ----------
let oldLog = [];
try { if (fm.fileExists(logFile)) oldLog = fm.readString(logFile).split('\n').filter((l) => l); } catch (e) { /* egal */ }
const logLines = [];
function step(msg) {
  const line = '[' + ((Date.now() - t0) / 1000).toFixed(2) + ' s] ' + msg;
  logLines.push(line);
  console.log(line);
  try {
    const all = oldLog.concat(['', '=== ' + new Date(t0).toISOString() + ' · ' + VERSION + ' ==='], logLines);
    fm.writeString(logFile, all.slice(-LOG_MAX_LINES).join('\n') + '\n');
  } catch (e) { /* Protokoll darf nichts stoppen */ }
}

// ---------- Texte ----------
const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v ? v[k] : ''));
async function readText(path) {
  await fm.downloadFileFromiCloud(path);
  return fm.readString(path);
}
const I18N_ALL = new Function('var window = {};\n' + (await readText(fm.joinPath(appDir, 'i18n.js'))) + '\nreturn window.I18N;')();
let T = I18N_ALL.de; // Sprache (8b): in main() nach Einstellung bzw. Systemsprache gesetzt
// Systemsprache: erste bevorzugte Sprache des iPads (Device.preferredLanguages, z. B. „de-DE“); Deutsch → de, sonst en
let SYS_LANG = 'de';
function detectLang() {
  let first = '';
  try { const pl = Device.preferredLanguages(); first = String((pl && pl[0]) || ''); } catch (e) { /* ältere Scriptable-Fassung */ }
  if (!first) { try { first = String(Device.language() || ''); } catch (e) { /* egal */ } }
  SYS_LANG = /^de/i.test(first) ? 'de' : 'en';
  return first;
}
const effLang = (s) => (s && I18N_ALL[s.lang] ? s.lang : SYS_LANG);

async function showAlert(message) {
  const a = new Alert();
  a.title = T.appName;
  a.message = message;
  a.addAction(T.ok);
  await a.presentAlert();
}

// ---------- Hilfen ----------
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
const js = (v) => JSON.stringify(v);

// ---------- Projekte ----------
function pad(n) { return String(n).padStart(2, '0'); }
function cleanName(name) {
  const s = String(name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60);
  if (!s) throw new Error('leerer Name');
  return s;
}
// 9e.3: Ordner heißen wie das Projekt; die Kennung (project.json → id) bleibt fest. Zuordnung Kennung → Ordner: app/projekte.js
let store = null;
const projectDir = (id) => {
  const d = /^[A-Za-z0-9_-]+$/.test(String(id)) ? store.dirSync(id) : null;
  if (!d) throw new Error(T.projectNotFound);
  return d;
};
async function readMeta(id) {
  const f = fm.joinPath(projectDir(id), 'project.json');
  if (!fm.fileExists(f)) throw new Error(T.projectNotFound);
  return JSON.parse(await readText(f));
}
function writeMeta(id, meta) {
  fm.writeString(fm.joinPath(projectDir(id), 'project.json'), JSON.stringify(meta, null, 2));
}
async function createProject(name, code) {
  const p = await store.create(cleanName(name));
  fm.writeString(fm.joinPath(p.dir, 'model.scad'), code);
  return p.id;
}
async function listProjects() {
  const list = [];
  for (const [id, folder] of await store.index(true)) {
    try {
      // nur Ordner mit model.scad: reine Slicer-Projekte (nur Druckplatte) gehören nicht in die Studio-Liste
      if (!fm.fileExists(fm.joinPath(fm.joinPath(projectsDir, folder), 'model.scad'))) continue;
      const meta = await readMeta(id);
      list.push({ id, name: meta.name, modified: meta.modified || meta.created, kind: meta.kind === 'test' ? 'test' : undefined });
    } catch (e) {
      step('Projekt „' + id + '“ übersprungen: ' + e);
    }
  }
  list.sort((a, b) => (a.kind === 'test') - (b.kind === 'test') ? (a.kind === 'test' ? -1 : 1) : String(b.modified).localeCompare(String(a.modified))); // 10n: Testwürfel oben
  return list;
}
function safeFileName(name) {
  return String(name).replace(/[\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'modell';
}
// Nur Dateien in projects/<id>/export/ dürfen geteilt werden
function checkExportPath(path) {
  const p = String(path);
  if (p.indexOf(projectsDir) !== 0 || p.indexOf('/export/') < 0 || p.indexOf('..') >= 0 || !fm.fileExists(p)) throw new Error('Datei nicht gefunden: ' + p);
  return p;
}
// Einstellungen mit Vorgaben; nur bekannte Werte werden übernommen (Grenzen geprüft)
const SETTINGS_DEFAULTS = { openLast: false, fontSize: 15, historyMax: 20, aiAgent: 'apple-cloud', viewMode: 'both', splitWide: 42, splitTall: 50, theme: 'system' };
function cleanSettings(s) {
  const n = (v, min, max, d) => (typeof v === 'number' && isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d);
  return {
    openLast: typeof s.openLast === 'boolean' ? s.openLast : SETTINGS_DEFAULTS.openLast,
    fontSize: n(s.fontSize, 11, 24, SETTINGS_DEFAULTS.fontSize),
    historyMax: n(s.historyMax, 5, 100, SETTINGS_DEFAULTS.historyMax),
    aiAgent: T.agents.some((a) => a.id === s.aiAgent) ? s.aiAgent : SETTINGS_DEFAULTS.aiAgent,
    viewMode: ['edit', 'both', 'view'].indexOf(s.viewMode) >= 0 ? s.viewMode : SETTINGS_DEFAULTS.viewMode,
    splitWide: n(s.splitWide, 10, 90, SETTINGS_DEFAULTS.splitWide),
    splitTall: n(s.splitTall, 10, 90, SETTINGS_DEFAULTS.splitTall),
    theme: ['system', 'dark', 'light'].indexOf(s.theme) >= 0 ? s.theme : SETTINGS_DEFAULTS.theme,
    lang: s.lang === 'de' || s.lang === 'en' ? s.lang : undefined, // nur, wenn der Nutzer gewählt hat (sonst Systemsprache)
  };
}
function readSettings() {
  let s = {};
  try { if (fm.fileExists(settingsFile)) s = JSON.parse(fm.readString(settingsFile)); } catch (e) { step('settings.json unlesbar: ' + e); }
  return Object.assign({}, s, cleanSettings(s));
}
function writeSettings(s) { fm.writeString(settingsFile, JSON.stringify(s, null, 2)); }

// ---------- Versionen (history/) ----------
// Zwischenstände als projects/<id>/history/model_JJJJMMTT-HHMMSS[-n].scad, älteste zuerst
const HISTORY_RE = /^model_\d{8}-\d{6}(-\d+)?\.scad$/;
const historyDir = (id) => fm.joinPath(projectDir(id), 'history');
function historyFiles(id) {
  const dir = historyDir(id);
  if (!fm.fileExists(dir)) return [];
  // nach Zeit und laufender Nummer sortieren (alphabetisch käme „…-2.scad“ vor „….scad“)
  const key = (f) => { const m = /^model_(\d{8}-\d{6})(?:-(\d+))?/.exec(f); return [m[1], Number(m[2] || 1)]; };
  return fm.listContents(dir).filter((f) => HISTORY_RE.test(f)).sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1];
  });
}
async function snapshot(id, code) {
  const dir = historyDir(id);
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const files = historyFiles(id);
  if (files.length) {
    const last = await readText(fm.joinPath(dir, files[files.length - 1]));
    if (last === code) return false; // unverändert → keine neue Version
  }
  const d = new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  // Laufende Nummer immer HINTER der höchsten vorhandenen derselben Sekunde – sonst könnte der Name einer gerade
  // gelöschten älteren Version wiederverwendet und die neue Version falsch einsortiert werden
  let maxN = 0;
  for (const f of files) { const m = /^model_(\d{8}-\d{6})(?:-(\d+))?\.scad$/.exec(f); if (m && m[1] === stamp) maxN = Math.max(maxN, Number(m[2] || 1)); }
  const name = 'model_' + stamp + (maxN ? '-' + (maxN + 1) : '') + '.scad';
  fm.writeString(fm.joinPath(dir, name), code);
  const all = historyFiles(id);
  const max = readSettings().historyMax;
  for (const old of all.slice(0, Math.max(0, all.length - max))) fm.remove(fm.joinPath(dir, old));
  step('Version gesichert: ' + id + '/history/' + name + ' (' + Math.min(all.length, max) + ' von max. ' + max + ')');
  return true;
}

// ---------- KI ----------
// Ablauf: Seite schickt Wunsch + Code → hier entstehen ai/prompt.txt und ai/request.json → Kurzbefehl „ScriptSCAD KI“
// wird per x-callback-url gestartet (CallbackURL wartet, Scriptable bleibt offen) → Antwort kommt als Ergebnis des
// Kurzbefehls (Parameter „result“) oder als Datei ai/response.txt → OpenSCAD-Codeblock herausziehen → Vorschau in der Seite.
const aiHistoryFile = (id) => fm.joinPath(projectDir(id), 'ai-history.json');
async function readAiHistory(id) {
  try { const f = aiHistoryFile(id); if (fm.fileExists(f)) return JSON.parse(await readText(f)); } catch (e) { step('ai-history.json unlesbar: ' + e); }
  return [];
}
function writeAiHistory(id, list) { fm.writeString(aiHistoryFile(id), JSON.stringify(list.slice(-50), null, 1)); }
async function updateAiHistory(id, reqId, change) {
  const list = await readAiHistory(id);
  const e = list.find((x) => x.id === reqId);
  if (e) { Object.assign(e, change); writeAiHistory(id, list); }
  return list;
}
// ChatGPT-App (iPad 8a.6): Antwort ganz ohne Zeilenumbrüche – jeder Umbruch wurde zu einem Leerzeichen, die Einrückungen
// (mehrere Leerzeichen) blieben erhalten. Dann „verschluckt“ der erste //-Kommentar den ganzen restlichen Code.
// Erkennen: sehr lange Zeile mit mehreren Anweisungen; Zeilen zurückgewinnen aus Leerzeichen-Läufen, ; { } und Kommentar-Enden.
function looksFlat(text) {
  const lines = text.split('\n');
  const long = lines.filter((l) => l.length > 300 && (l.match(/;/g) || []).length >= 3);
  return long.length > 0 && lines.length <= 8;
}
const CODE_START = [
  / {2,}(?=\S)/, // Lauf aus Leerzeichen = früherer Zeilenumbruch + Einrückung bzw. Leerzeile
  / (?=\/\/|\/\*)/, // nächster Kommentar
  / (?=[A-Za-z_$][\w$]*\s*=(?!=))/, // Zuweisung (Wörter mit Umlaut passen nicht → Text bleibt Kommentar)
  / (?=[A-Za-z_$][\w$]*\()/, // Aufruf ohne Leerzeichen vor „(“ (im Fließtext steht meist eins davor)
  / (?=(for|if|let|intersection_for)\s*\(|(module|function|include|use)\b)/,
  / (?=[{}])/,
];
function commentEnd(s, i) {
  const rest = s.slice(i + 2);
  const cust = /^\s*\[[^\]]*\]/.exec(rest); // Customizer-Angabe // [min:max] endet mit „]“
  if (cust) return i + 2 + cust[0].length;
  let best = s.length;
  for (const re of CODE_START) { const m = re.exec(rest); if (m) best = Math.min(best, i + 2 + m.index); }
  return best;
}
function unflatten(text) {
  let s = text.replace(/\s*\n\s*/g, '  ');
  let pre = '';
  const lab = /(^|\s)(openscad|scad)\s*:?\s+(?=\/\/|\/\*|[A-Za-z_$])/i.exec(s);
  if (lab) { pre = s.slice(0, lab.index).trim(); s = s.slice(lab.index + lab[0].length); }
  const out = [];
  let line = '';
  const push = () => { const t = line.trim(); if (t) out.push(t); line = ''; };
  let depth = 0; // runde/eckige Klammern: darin nie umbrechen
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      line += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); const e = j < 0 ? s.length : j + 2; line += s.slice(i, e); i = e; continue; }
    if (c === '/' && s[i + 1] === '/') {
      const e = commentEnd(s, i);
      const com = s.slice(i, e).trimEnd();
      // Kommentar direkt (ein Leerzeichen) hinter „;“ sowie Customizer-Angaben gehören in dieselbe Zeile (breite = 60; // [20:150])
      if (!line.trim() && ((s[i - 1] === ' ' && s[i - 2] !== ' ') || /^\/\/\s*\[/.test(com)) && out.length && /;$/.test(out[out.length - 1])) out[out.length - 1] += ' ' + com;
      else { push(); line = com; push(); }
      line = '';
      i = e;
      continue;
    }
    if (c === ' ' && s[i + 1] === ' ') {
      let j = i;
      while (s[j] === ' ') j++;
      const prev = line.trimEnd().slice(-1);
      const next = s[j] || '';
      const joins = /[=+\-*%<>?:,(\[&|!]/.test(prev) || (/[=+\-*%<>?:,)\]&|.]/.test(next)) || (next === '/' && s[j + 1] !== '/' && s[j + 1] !== '*');
      if (depth === 0 && !joins) {
        push();
        // Umbruch = 1 Leerzeichen + Einrückung (gerade Anzahl, 2er- oder 4er-Schritte) → ungerade Länge;
        // eine Leerzeile bringt ein weiteres Leerzeichen → gerade Länge
        if ((j - i) % 2 === 0 && out.length && out[out.length - 1] !== '' && !/^\/\/\s*\[/.test(s.slice(j, j + 12))) out.push('');
      } else line += ' ';
      i = j;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (c === '}' && depth === 0) push();
    line += c;
    i++;
    if (depth === 0 && (c === ';' || c === '{' || c === '}')) push();
  }
  push();
  // neu einrücken nach geschweiften Klammern
  let d = 0;
  const res = out.map((l) => {
    if (!l) return '';
    if (l.startsWith('//') || l.startsWith('/*')) return '    '.repeat(d) + l;
    if (l.startsWith('}')) d = Math.max(0, d - 1);
    const r = '    '.repeat(d) + l;
    d = Math.max(0, d + (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length + (l.startsWith('}') ? 1 : 0));
    return r;
  });
  while (res.length && !res[res.length - 1]) res.pop();
  return (pre ? pre + '\n\n' : '') + res.join('\n') + '\n';
}
// Codeblock aus der Antwort: bevorzugt ```openscad / ```scad, sonst der längste ```-Block
function extractCode(answer) {
  if (!answer.includes('```') && looksFlat(answer)) {
    answer = unflatten(answer);
    step('Antwort ohne Zeilenumbrüche erkannt → ' + answer.split('\n').length + ' Zeilen wiederhergestellt');
  }
  const blocks = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(answer))) blocks.push({ lang: m[1].toLowerCase(), code: m[2], start: m.index, end: re.lastIndex });
  if (!blocks.length) {
    // Ohne ```: Code-Bereich = erste bis letzte Zeile, die wie OpenSCAD aussieht (Code oder Kommentar).
    // Die ChatGPT-App liefert formatierten Text – dabei gehen die ``` verloren, übrig bleibt eine Zeile „openscad“ (iPad 6a.1).
    const lines = answer.replace(/\r\n?/g, '\n').split('\n');
    const isLabel = (l) => /^\s*(openscad|scad)\s*:?\s*$/i.test(l);
    const isCode = (l) => !isLabel(l) && (/^\s*(\/\/|\/\*|\*)/.test(l) || /[;{}(),\]]\s*(\/\/.*)?$/.test(l.trim()));
    let first = lines.findIndex(isCode);
    let last = lines.length - 1;
    while (last >= 0 && !isCode(lines[last])) last--;
    if (first < 0) return null;
    const region = lines.slice(first, last + 1);
    const filled = region.filter((l) => l.trim());
    if (!region.join('\n').includes(';') || filled.filter(isCode).length < filled.length * 0.7) return null;
    const text = lines.slice(0, first).concat(lines.slice(last + 1)).filter((l) => !isLabel(l)).join('\n').trim();
    return { code: region.join('\n').replace(/\s+$/, '') + '\n', text };
  }
  const tagged = blocks.filter((b) => b.lang === 'openscad' || b.lang === 'scad');
  const pick = (tagged.length ? tagged : blocks).reduce((x, y) => (y.code.length > x.code.length ? y : x));
  const text = (answer.slice(0, pick.start) + answer.slice(pick.end)).trim();
  return { code: pick.code.replace(/\s+$/, '') + '\n', text };
}
// Bild auf höchstens max Pixel (lange Seite) verkleinern – Fotos haben oft 12 MP, das ist für die KI unnötig groß
function scaleImage(img, max) {
  const s = img.size;
  const f = Math.min(1, max / Math.max(s.width, s.height));
  if (f >= 1) return img;
  const dc = new DrawContext();
  dc.respectScreenScale = false;
  dc.opaque = true;
  dc.size = new Size(Math.round(s.width * f), Math.round(s.height * f));
  dc.drawImageInRect(img, new Rect(0, 0, dc.size.width, dc.size.height));
  return dc.getImage();
}
const viewFile = () => fm.joinPath(aiDir, 'view.jpg');

// ---------- Datei-Upload für die KI (8a.9): Fotos aus der Galerie und beliebige Dateien aus der Dateien-App ----------
// Hochgeladene Dateien liegen als ai/upload-<Zeit>-<n>.<endung> direkt im Ordner ai (der Kurzbefehl liest nur dort),
// Beschreibung in ai/uploads.json. Wie sie an die KI gehen, entscheidet die Art:
//   Bild (→ JPEG verkleinert), PDF, sonstige Datei → als Datei angehängt (Liste „images“ in request.json, die der Kurzbefehl schon kennt)
//   Text (.scad, .txt, .csv …)                       → Inhalt steht im Prompt (zuverlässiger als ein Anhang)
//   STL                                               → Kurzbeschreibung im Prompt (Dreiecke, Maße) – KI-Apps können STL nicht lesen
const UPLOAD_MAX_FILES = 5;
const UPLOAD_MAX_MB = 20;
const UPLOAD_TEXT_MAX = 60000; // Zeichen; längere Texte werden gekürzt
const UPLOAD_KINDS = {
  image: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'bmp'],
  pdf: ['pdf'],
  stl: ['stl'],
  text: ['scad', 'txt', 'csv', 'tsv', 'json', 'md', 'svg', 'dxf', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'log', 'obj', 'gcode', 'js', 'py', 'html', 'htm'],
};
const uploadsFile = () => fm.joinPath(aiDir, 'uploads.json');
function uploadKind(ext) {
  for (const [k, list] of Object.entries(UPLOAD_KINDS)) if (list.includes(ext)) return k;
  return 'other';
}
function readUploads() {
  try { return fm.fileExists(uploadsFile()) ? JSON.parse(fm.readString(uploadsFile())) : []; } catch (e) { return []; }
}
function writeUploads(list) { fm.writeString(uploadsFile(), JSON.stringify(list, null, 2)); }
// Alle hochgeladenen Dateien löschen (beim Wechsel des Projekts / beim Start), außer eine Anfrage wartet noch auf ihre Antwort
function clearUploads(keep) {
  if (!fm.fileExists(aiDir)) return;
  const keepSet = new Set(keep || []);
  for (const f of fm.listContents(aiDir)) if (/^upload-/.test(f) && !keepSet.has(f)) { try { fm.remove(fm.joinPath(aiDir, f)); } catch (e) { /* egal */ } }
  writeUploads(readUploads().filter((u) => keepSet.has(u.file)));
}
// STL (binär oder ASCII): Anzahl Dreiecke und Maße für den Prompt
function stlSummary(data) {
  const bytes = data.getBytes();
  const n = bytes.length;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const add = (x, y, z) => { const v = [x, y, z]; for (let i = 0; i < 3; i++) { if (v[i] < lo[i]) lo[i] = v[i]; if (v[i] > hi[i]) hi[i] = v[i]; } };
  let tris = 0;
  let binary = false;
  if (n >= 84) {
    const count = bytes[80] | (bytes[81] << 8) | (bytes[82] << 16) | (bytes[83] << 24);
    binary = count >= 0 && 84 + count * 50 === n;
    if (binary) {
      const dv = new DataView(Uint8Array.from(bytes).buffer);
      tris = count;
      for (let t = 0; t < count; t++) {
        const o = 84 + t * 50 + 12;
        for (let v = 0; v < 3; v++) add(dv.getFloat32(o + v * 12, true), dv.getFloat32(o + v * 12 + 4, true), dv.getFloat32(o + v * 12 + 8, true));
      }
    }
  }
  if (!binary) {
    const text = data.toRawString() || '';
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m, verts = 0;
    while ((m = re.exec(text))) { add(Number(m[1]), Number(m[2]), Number(m[3])); verts++; }
    tris = Math.floor(verts / 3);
  }
  if (!tris || !isFinite(lo[0])) return { ok: false, text: T.uploadStlUnreadable };
  const r = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
  const size = [0, 1, 2].map((i) => r(hi[i] - lo[i])).join(' × ');
  return { ok: true, text: fmt(T.uploadStlInfo, { format: binary ? T.uploadStlBinary : T.uploadStlAscii, tris, size,
    x: r(lo[0]) + '…' + r(hi[0]), y: r(lo[1]) + '…' + r(hi[1]), z: r(lo[2]) + '…' + r(hi[2]) }) };
}
function safeName(name) { return String(name || 'Datei').replace(/[\/\\:*?"<>|\n\r\t]/g, '_').slice(0, 80); }
// Eine Datei (Data) als Upload ablegen → Eintrag für uploads.json und die Seite (mit Vorschaubild bei Bildern)
function storeUpload(data, origName, img) {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(origName) || [])[1];
  const lower = ext ? ext.toLowerCase() : '';
  let kind = img ? 'image' : uploadKind(lower);
  const id = 'upload-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const entry = { file: '', name: safeName(origName), kind, kb: 0, note: '' };
  let thumb = null;
  if (kind === 'image') {
    const im = img || Image.fromData(data);
    if (im) {
      const big = scaleImage(im, 1600);
      entry.file = id + '.jpg';
      const jpg = Data.fromJPEG(big);
      fm.write(fm.joinPath(aiDir, entry.file), jpg);
      thumb = Data.fromJPEG(scaleImage(im, 360)).toBase64String();
      entry.note = im.size.width + '×' + im.size.height + ' → ' + big.size.width + '×' + big.size.height;
    } else kind = entry.kind = 'other'; // Bildformat nicht lesbar → als Datei anhängen
  }
  if (kind === 'text') {
    const text = data.toRawString();
    if (text == null) kind = entry.kind = 'other';
    else { entry.chars = text.length; entry.truncated = text.length > UPLOAD_TEXT_MAX; }
  }
  if (kind === 'stl') {
    const sum = stlSummary(data);
    entry.summary = sum.text;
    entry.note = sum.text;
  }
  if (!entry.file) {
    entry.file = id + (lower ? '.' + lower : '');
    fm.write(fm.joinPath(aiDir, entry.file), data);
  }
  entry.kb = Math.round((fm.fileSize(fm.joinPath(aiDir, entry.file)) || 0) * 10) / 10;
  return { entry, thumb };
}
async function aiPickFile(wv, source) {
  if (!fm.fileExists(aiDir)) fm.createDirectory(aiDir, true);
  const list = readUploads();
  const added = [];
  const problems = [];
  const room = () => UPLOAD_MAX_FILES - list.length - added.length;
  if (room() <= 0) { await run(wv, 'App.toast(' + js(fmt(T.uploadTooMany, { n: UPLOAD_MAX_FILES })) + ')'); return; }
  if (source === 'photos') {
    let img;
    try { img = await Photos.fromLibrary(); } catch (e) { step('Galerie: abgebrochen (' + e + ')'); return; }
    if (!img) return;
    added.push(storeUpload(null, T.uploadPhotoName + '.jpg', img));
  } else {
    let paths;
    try { paths = await DocumentPicker.open(); } catch (e) { step('Dateien: abgebrochen (' + e + ')'); return; }
    for (const p of paths || []) {
      const name = String(p).split('/').pop();
      if (room() <= 0) { problems.push(fmt(T.uploadTooMany, { n: UPLOAD_MAX_FILES })); break; }
      try {
        let kb = null;
        try { kb = FileManager.local().fileSize(p); } catch (e) { /* unbekannt */ }
        if (kb != null && kb > UPLOAD_MAX_MB * 1024) { problems.push(fmt(T.uploadTooBig, { name, mb: UPLOAD_MAX_MB })); continue; }
        const data = Data.fromFile(p);
        if (!data) { problems.push(fmt(T.uploadUnreadable, { name })); continue; }
        added.push(storeUpload(data, name, null));
      } catch (e) {
        step('Upload-Fehler ' + name + ': ' + e);
        problems.push(fmt(T.uploadUnreadable, { name }));
      }
    }
  }
  writeUploads(list.concat(added.map((a) => a.entry)));
  for (const a of added) step('Upload: ' + a.entry.name + ' → ai/' + a.entry.file + ' (' + a.entry.kind + ', ' + a.entry.kb + ' KB' + (a.entry.note ? ', ' + a.entry.note : '') + ')');
  const files = added.map((a) => Object.assign({}, a.entry, { thumb: a.thumb, label: T.uploadKinds[a.entry.kind] }));
  await run(wv, 'App.aiFiles(' + js(js({ files, problems })) + ')', false, 10000, 'Dateien anzeigen');
}
function removeUpload(file) {
  const list = readUploads();
  const f = String(file || '');
  if (!/^upload-[\w.-]+$/.test(f)) return;
  if (fm.fileExists(fm.joinPath(aiDir, f))) fm.remove(fm.joinPath(aiDir, f));
  writeUploads(list.filter((u) => u.file !== f));
  step('Upload entfernt: ' + f);
}
// Hinweise für den Prompt + Liste der anzuhängenden Dateien aus den gewählten Uploads
function uploadsForPrompt(chosen, offset, copy) {
  const want = new Set((Array.isArray(chosen) ? chosen : []).map(String));
  const used = readUploads().filter((u) => want.has(u.file) && fm.fileExists(fm.joinPath(aiDir, u.file)));
  const attach = [];
  let note = '';
  for (const u of used) {
    const kindLabel = T.uploadKinds[u.kind] || T.uploadKinds.other;
    if (u.kind === 'text') {
      let text = '';
      try { text = fm.readString(fm.joinPath(aiDir, u.file)) || ''; } catch (e) { text = ''; }
      const cut = text.length > UPLOAD_TEXT_MAX;
      note += fmt(T.uploadPromptText, { name: u.name, text: (cut ? text.slice(0, UPLOAD_TEXT_MAX) : text).replace(/\s+$/, ''), cut: cut ? fmt(T.uploadPromptCut, { n: UPLOAD_TEXT_MAX }) : '' });
    } else if (u.kind === 'stl') {
      note += fmt(T.uploadPromptStl, { name: u.name, summary: u.summary || T.uploadStlUnreadable });
    } else {
      attach.push('ai/' + u.file);
      note += fmt(copy ? T.uploadPromptFileCopy : T.uploadPromptFile, { n: (offset || 0) + attach.length, file: u.file, name: u.name, kind: kindLabel });
    }
  }
  return { used, attach, note };
}
async function saveViewToPhotos(wv, b64) {
  const img = Image.fromData(Data.fromBase64String(String(b64)));
  if (!img) throw new Error('Bild unlesbar');
  await Photos.save(img);
  step('Ansicht in Fotos gesichert (' + img.size.width + '×' + img.size.height + ')');
  await run(wv, 'App.toast(' + js(T.aiSavedToPhotos) + ')');
}
function testAnswer(code) {
  const changed = code.replace(/^(\s*[A-Za-z_]\w*\s*=\s*)(\d+(?:\.\d+)?)(\s*;)/m, (m0, a, n, b) => a + (Number(n) + 10) + b);
  return T.aiTestText + '\n\n```openscad\n' + T.aiTestComment + '\n' + changed.replace(/\s+$/, '') + '\n```\n';
}
// Test-Agent, Reparatur: Zeilen entfernen, auf die eine Fehlermeldung zeigt
function testRepair(code, errors) {
  const bad = new Set();
  for (const e of errors) { const m = /^(ERROR|WARNING):.*line (\d+)/.exec(e); if (m) bad.add(Number(m[2])); }
  const fixed = code.split('\n').filter((l, i) => !bad.has(i + 1)).join('\n');
  return T.aiTestRepairText + '\n\n```openscad\n' + fixed.replace(/\s+$/, '') + '\n```\n';
}
// Prompt aufbauen (für den Kurzbefehl und für „In Zwischenablage kopieren“). copy = true: Claude-App per Kopieren/Einfügen (7f) –
// Bilder/PDFs kann ein Text nicht enthalten → der Nutzer hängt sie in der Claude-App selbst an; Ansicht/Skizze landet dafür in Fotos.
function buildAiPrompt(a, copy) {
  const repair = a.mode === 'repair';
  const wish = String(a.prompt || '').trim();
  const code = String(a.code || '');
  const errors = Array.isArray(a.errors) ? a.errors.map(String).slice(0, 30) : [];
  if (!wish && !repair) throw new Error(T.aiEmptyPrompt);
  if (repair && !errors.length) throw new Error(T.aiRepairNothing);
  if (!fm.fileExists(aiDir)) fm.createDirectory(aiDir, true);
  // Bilder: Ansicht (ggf. mit Skizze) und/oder Foto aus der Galerie
  const images = [];
  let imageNote = '';
  if (a.view) {
    fm.write(viewFile(), Data.fromBase64String(String(a.view)));
    images.push('ai/view.jpg');
    imageNote += a.sketch ? T.aiImageSketch : T.aiImageView;
  }
  // Hochgeladene Dateien (8a.9): Bilder/PDFs/sonstige als Anhang, Texte und STL-Beschreibung im Prompt
  const up = repair ? { used: [], attach: [], note: '' } : uploadsForPrompt(a.files, images.length, copy);
  images.push(...up.attach);
  if (images.length) imageNote = (copy ? T.aiCopyAttachRule : T.aiAttachRule) + imageNote;
  let prompt = repair
    ? fmt(T.aiRepairPrompt, { wish: wish ? fmt(T.aiRepairWish, { wish }) : '', errors: errors.join('\n'), code: code.replace(/\s+$/, '') })
    : fmt(T.aiPrompt, { wish, code: code.replace(/\s+$/, ''), image: imageNote, files: up.note ? fmt(T.uploadPromptHead, { list: up.note }) : '' });
  if (a.id) prompt += partsPromptNote(a.id); // 10i: Teile im Projekt (import)
  if (copy) prompt += '\n' + T.aiCopyAnswerRule;
  return { repair, wish, code, errors, images, up, prompt };
}

// Claude-App (7f): Prompt + Text-Anhänge als EIN Text in die Zwischenablage; kein Kurzbefehl, kein Warten.
// Die Antwort holt der Nutzer mit „Einfügen“ (pasteCode, 8a.8) zurück.
async function aiCopy(wv, a) {
  let res;
  try {
    const b = buildAiPrompt(a, true);
    Pasteboard.copyString(b.prompt);
    fm.writeString(fm.joinPath(aiDir, 'prompt.txt'), b.prompt);
    let photo = false;
    if (a.view) {
      try { await Photos.save(Image.fromData(Data.fromBase64String(String(a.view)))); photo = true; } catch (e) { step('Ansicht nicht in Fotos gesichert: ' + e); }
    }
    const attach = b.up.used.filter((u) => b.images.includes('ai/' + u.file)).map((u) => u.name);
    const reqId = 'r' + Date.now();
    const histText = b.repair ? fmt(T.aiRepairHistory, { err: b.errors[0] }) : b.wish;
    const hist = await readAiHistory(a.id);
    hist.push(Object.assign({ id: reqId, time: new Date().toISOString(), agent: 'claude-app', prompt: histText, result: 'copied', note: T.aiCopiedNote, images: b.images.length, files: b.up.used.length }, b.repair ? { mode: 'repair' } : {}));
    writeAiHistory(a.id, hist);
    const s = readSettings();
    s.aiAgent = 'claude-app';
    writeSettings(s);
    step('KI-Prompt kopiert ' + reqId + ' (' + (b.repair ? 'Reparatur, ' : '') + b.prompt.length + ' Zeichen, Anhänge zum Selbst-Anhängen: ' + (b.images.join(', ') || 'keine') + (photo ? ', Ansicht in Fotos' : '') + ')');
    res = { ok: true, chars: b.prompt.length, attach, view: !!a.view, photo, sketch: !!a.sketch };
    await run(wv, 'App.setAiHistory(' + js(js({ id: a.id, list: hist })) + ')', false, 10000, 'KI-Verlauf');
  } catch (e) {
    step('FEHLER Prompt kopieren: ' + e);
    res = { ok: false, error: String((e && e.message) || e) };
  }
  await run(wv, 'App.aiCopied(' + js(js(res)) + ')', false, 10000, 'Kopiert');
}

async function aiSend(wv, a) {
  const meta = await readMeta(a.id);
  const agent = T.agents.some((x) => x.id === a.agent) ? a.agent : SETTINGS_DEFAULTS.aiAgent;
  const { repair, wish, code, errors, images, up, prompt } = buildAiPrompt(a, false);
  const reqId = 'r' + Date.now();
  const createdAt = new Date().toISOString();
  const histText = repair ? fmt(T.aiRepairHistory, { err: errors[0] }) : wish;
  fm.writeString(fm.joinPath(aiDir, 'prompt.txt'), prompt);
  const request = { version: 1, id: reqId, createdAt, agent, mode: repair ? 'repair' : 'change', project: a.id, projectName: meta.name,
    scadPath: 'projects/' + (await store.folderOf(a.id)) + '/model.scad', promptPath: 'ai/prompt.txt', prompt: histText, imagePath: images[0] || null, images,
    files: up.used.map((u) => ({ file: 'ai/' + u.file, name: u.name, kind: u.kind, attached: up.attach.includes('ai/' + u.file) })), status: 'sent' };
  fm.writeString(fm.joinPath(aiDir, 'request.json'), JSON.stringify(request, null, 2));
  const respFile = fm.joinPath(aiDir, 'response.txt');
  if (fm.fileExists(respFile)) fm.remove(respFile);
  const hist = await readAiHistory(a.id);
  hist.push(Object.assign({ id: reqId, time: createdAt, agent, prompt: histText, result: 'sent', images: images.length, files: up.used.length }, repair ? { mode: 'repair' } : {}));
  writeAiHistory(a.id, hist);
  const s = readSettings();
  s.aiAgent = agent;
  writeSettings(s);
  step((repair ? 'KI-Reparatur ' : 'KI-Anfrage ') + reqId + ' an ' + agent + ' (' + (repair ? errors.length + ' Meldungen, ' : '') + wish.length + ' Zeichen Wunsch, ' + prompt.length + ' Zeichen gesamt, Anhänge: ' + (images.join(', ') || 'keine') + (up.used.length ? ', Uploads: ' + up.used.map((u) => u.name + ' (' + u.kind + ')').join(', ') : '') + ')');

  let answer = null;
  let error = null;
  let diag = ''; // Diagnose für die Oberfläche: wann und womit kam der Kurzbefehl zurück
  if (agent === 'test') {
    await sleep(800);
    answer = (repair ? testRepair(code, errors) : testAnswer(code)) + (images.length ? '\n' + fmt(T.aiTestImages, { n: images.length }) : '') + (up.used.length ? '\n' + fmt(T.aiTestFiles, { list: up.used.map((u) => u.name).join(', ') }) : '');
  } else {
    let tCb = Date.now();
    let done = false; // Kurzbefehl ab 8a.6 meldet nur „fertig“, die Antwort steht in ai/response.txt
    try {
      const cb = new CallbackURL('shortcuts://x-callback-url/run-shortcut');
      cb.addParameter('name', SHORTCUT_NAME);
      cb.addParameter('input', 'text');
      cb.addParameter('text', agent);
      step('Kurzbefehl starten: ' + cb.getURL());
      tCb = Date.now();
      const res = await cb.open();
      const result = res && typeof res.result === 'string' ? res.result : '';
      step('Kurzbefehl zurück nach ' + Math.round((Date.now() - tCb) / 1000) + ' s, Parameter: ' + js(Object.keys(res || {})) + ', result: ' + result.length + ' Zeichen');
      if (result.trim() === SHORTCUT_DONE) done = true;
      else if (result.trim()) answer = result;
    } catch (e) {
      error = String((e && e.message) || e);
      const sec = Math.round((Date.now() - tCb) / 1000);
      diag = fmt(T.aiDiag, { sec, msg: error });
      step('Kurzbefehl meldet nach ' + sec + ' s Fehler/Abbruch: ' + error);
    }
    // Bevorzugt die Datei: sie enthält immer die vollständige Antwort (Rückgabe per URL kann bei langen Texten scheitern)
    if (done || !answer) {
      const r = await tryReadResponse(respFile);
      if (r.text && r.text.trim()) { answer = r.text; step('Antwort aus ai/response.txt gelesen'); }
      else if (r.exists) step('ai/response.txt vorhanden, aber ' + (r.error ? 'nicht lesbar: ' + r.error : 'leer'));
    }
    // Scriptable wurde vor dem Ende des Kurzbefehls wieder in den Vordergrund geholt (CallbackURL bricht dann ab),
    // der Kurzbefehl läuft aber weiter und schreibt am Ende ai/response.txt → darauf warten.
    // Ebenso, wenn der Kurzbefehl „fertig“ meldet, die Datei aber noch nicht lesbar ist (iCloud).
    if (!answer && (done || (error && /returned to Scriptable|zurück(gekehrt)? zu Scriptable/i.test(error)))) {
      step(done ? 'Kurzbefehl fertig, ai/response.txt noch nicht lesbar → warte' : 'Scriptable vor dem Ende des Kurzbefehls zurückgeholt → warte bis ' + AI_WAIT_MIN + ' min auf ai/response.txt');
      const w = await waitForResponse(wv, respFile, done ? T.aiWaitFile : '', diag);
      if (w.answer) { answer = w.answer; error = null; step('Antwort nach ' + w.sec + ' s aus ai/response.txt gelesen'); } else {
        error = (w.cancelled ? T.aiWaitCancelled : fmt(T.aiWaitTimeout, { min: AI_WAIT_MIN })) + (diag ? '\n\n' + diag : '');
        step(w.cancelled ? 'Warten vom Nutzer abgebrochen' : 'Keine Antwort nach ' + AI_WAIT_MIN + ' min');
        await aiFinish(wv, a.id, reqId, agent, null, error, true);
        return;
      }
    }
  }
  if (!answer && diag) error = (error ? error + '\n\n' : '') + diag;
  await aiFinish(wv, a.id, reqId, agent, answer, error);
}
// Warten auf ai/response.txt (Kurzbefehl läuft im Hintergrund weiter). Ende: Antwort, Abbruch durch den Nutzer oder Zeitlimit.
// iPad 8a.4: Die vom Kurzbefehl geschriebene Datei ist für Scriptable zunächst „in iCloud, nicht geladen“ → fileSize() = null,
// readString() scheitert. Darum jede Runde downloadFileFromiCloud() und Inhalt statt Größe vergleichen (zweimal gleich = fertig).
const AI_WAIT_MIN = 5;
async function tryReadResponse(respFile) {
  if (!fm.fileExists(respFile)) return { exists: false };
  let loaded = null;
  try { loaded = fm.isFileDownloaded(respFile); } catch (e) { /* egal */ }
  try {
    await Promise.race([fm.downloadFileFromiCloud(respFile), timeout(20000, 'iCloud-Download response.txt')]);
    return { exists: true, loaded, text: fm.readString(respFile) };
  } catch (e) { return { exists: true, loaded, error: String((e && e.message) || e) }; }
}
async function waitForResponse(wv, respFile, text, diag) {
  const tStart = Date.now();
  await run(wv, 'App.aiBackgroundWait(' + js(AI_WAIT_MIN) + ',' + js(text || '') + ',' + js(diag || '') + ')', false, 5000, 'KI warten');
  let last = null;
  let lastNote = '';
  let lastLog = 0;
  const sec = () => Math.round((Date.now() - tStart) / 1000);
  const check = async () => {
    const r = await tryReadResponse(respFile);
    const note = !r.exists ? 'fehlt' : r.error ? 'nicht lesbar (' + r.error + ')' : (r.text || '').trim() ? r.text.length + ' Zeichen' : 'leer';
    // Diagnose: Zustand der Datei bei jeder Änderung und sonst alle 15 s ins Protokoll
    if (note !== lastNote || Date.now() - lastLog > 15000) {
      step('Warten ' + sec() + ' s: response.txt ' + note + (r.exists ? ', geladen: ' + r.loaded : ''));
      lastNote = note;
      lastLog = Date.now();
    }
    if (r.text && r.text.trim()) {
      if (r.text === last) return r.text;
      last = r.text;
    } else last = null;
    return null;
  };
  while (Date.now() - tStart < AI_WAIT_MIN * 60000) {
    await sleep(1000);
    const answer = await check();
    if (answer) return { answer, sec: sec() };
    let c;
    try { c = await run(wv, 'completion(App.aiCancelState())', true, 5000, 'KI warten'); } catch (e) { return { cancelled: true }; }
    if (c === 'true') {
      // letzte Chance: vielleicht ist die Antwort gerade angekommen
      const r = await tryReadResponse(respFile);
      if (r.text && r.text.trim()) return { answer: r.text, sec: sec() };
      return { cancelled: true };
    }
  }
  return {};
}
// keepPending: Anfrage bleibt „gesendet“ → kommt die Antwort später, wird sie beim nächsten Öffnen angeboten
async function aiFinish(wv, id, reqId, agent, answer, error, keepPending) {
  let res;
  if (!answer) {
    res = { ok: false, reqId, error: keepPending ? error : error ? error + '\n\n' + fmt(T.aiNoAnswer, { name: SHORTCUT_NAME }) : fmt(T.aiNoAnswer, { name: SHORTCUT_NAME }) };
  } else {
    fm.writeString(fm.joinPath(aiDir, 'response.txt'), answer);
    step('Antwort (' + answer.length + ' Zeichen), Anfang: ' + JSON.stringify(answer.slice(0, 120)));
    const ex = extractCode(answer);
    res = ex ? { ok: true, reqId, agent, code: ex.code, text: ex.text } : { ok: false, reqId, error: fmt(T.aiNoCode, { start: answer.trim().slice(0, 300) }) };
  }
  step('KI-Ergebnis ' + reqId + ': ' + (res.ok ? 'Code mit ' + res.code.split('\n').length + ' Zeilen' : 'Fehler – ' + res.error.split('\n')[0]));
  const list = await updateAiHistory(id, reqId, { result: res.ok ? 'ok' : 'error', note: res.ok ? (res.text || '').slice(0, 300) : res.error.slice(0, 300) });
  try {
    const rf = fm.joinPath(aiDir, 'request.json');
    const r = JSON.parse(fm.readString(rf));
    if (r.id === reqId && !keepPending) { r.status = res.ok ? 'done' : 'error'; fm.writeString(rf, JSON.stringify(r, null, 2)); }
  } catch (e) { /* egal */ }
  await run(wv, 'App.aiResult(' + js(js(res)) + ')', false, 10000, 'KI-Ergebnis');
  await run(wv, 'App.setAiHistory(' + js(js({ id, list })) + ')', false, 10000, 'KI-Verlauf');
}

// Nicht abgeholte Antwort: iOS kann Scriptable im Hintergrund beenden, während die KI rechnet. Der Kurzbefehl schreibt
// die Antwort zusätzlich nach ai/response.txt (aiSend löscht sie vor jeder Anfrage) → beim nächsten Öffnen anbieten.
function pendingAnswer() {
  try {
    const rf = fm.joinPath(aiDir, 'request.json');
    const resp = fm.joinPath(aiDir, 'response.txt');
    if (!fm.fileExists(rf) || !fm.fileExists(resp)) return null;
    const r = JSON.parse(fm.readString(rf));
    return r.status === 'sent' && r.id && r.project ? r : null;
  } catch (e) { step('Offene KI-Antwort nicht prüfbar: ' + e); return null; }
}
// Uploads einer noch offenen Anfrage (Kurzbefehl liest sie evtl. noch) nicht löschen
function pendingUploads() {
  try {
    const rf = fm.joinPath(aiDir, 'request.json');
    if (!fm.fileExists(rf)) return [];
    const r = JSON.parse(fm.readString(rf));
    return r.status === 'sent' && Array.isArray(r.files) ? r.files.map((f) => String(f.file).replace(/^ai\//, '')) : [];
  } catch (e) { return []; }
}
async function recoverAi(wv, id) {
  const r = pendingAnswer();
  if (!r || r.project !== id) return;
  const answer = await readText(fm.joinPath(aiDir, 'response.txt'));
  step('Nicht abgeholte KI-Antwort ' + r.id + ' (' + r.agent + ') gefunden → anbieten');
  await aiFinish(wv, id, r.id, r.agent, answer, null);
  await run(wv, 'App.toast(' + js(T.aiRecovered) + ')', false, 5000, 'Hinweis');
}

// Startvorlage, damit die Projektliste nie leer ist (bei Updates wird nur der app-Ordner ersetzt, Projekte bleiben)
// 10n: Testwürfel 20 mm wie im Slicer – fest oben in der Liste (fehlt er, wird er beim Start neu angelegt; Löschen ist gesperrt)
const TEST_CODE = '// Testwürfel 20 mm – gleiches Testmodell wie im Slicer\ncube(20);\n';
async function ensureTestProject(list) {
  if (list.some((p) => p.kind === 'test')) return;
  const id = await createProject(T.testCubeName, TEST_CODE);
  const meta = await readMeta(id);
  meta.kind = 'test';
  writeMeta(id, meta);
  step('Testwürfel angelegt: ' + id);
}
async function ensureProjects() {
  if (!fm.fileExists(projectsDir)) fm.createDirectory(projectsDir, true);
  const before = await listProjects();
  await ensureTestProject(before);
  const has = before.some((p) => p.kind !== 'test');
  if (!has) {
    const ex = fm.joinPath(appDir, T.exampleFile || 'beispiel.scad');
    const id = await createProject(T.exampleName, await readText(fm.fileExists(ex) ? ex : fm.joinPath(appDir, 'beispiel.scad')));
    step('Beispielprojekt angelegt: ' + id);
  }
}

// ---------- Aktionen der Oberfläche ----------
async function sendList(wv) {
  const list = await listProjects();
  await run(wv, 'App.setProjects(' + js(js(list)) + ')', false, 10000, 'Projektliste');
}

// ---------- 10l: Update-Prüfung (nur auf Knopfdruck, lädt nur auf Wunsch) ----------
// Quelle: app/update-quelle.json → { url } einer version.json { version, zip, notes }. Leer = noch nicht eingerichtet.
function cmpVersion(a, b) {
  const ta = String(a).match(/\d+|[a-z]+/gi) || [], tb = String(b).match(/\d+|[a-z]+/gi) || [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; } else if (nx !== ny) return nx ? 1 : -1; else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
async function updateSource() {
  try { const q = JSON.parse(await readText(fm.joinPath(appDir, 'update-quelle.json'))); return String(q.url || '').trim(); } catch (e) { return ''; }
}
let updateInfo = null;
async function checkUpdate(wv) {
  const url = await updateSource();
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url)) { step('Update-Prüfung: keine Quelle eingerichtet'); return { state: 'noSource', current: VERSION }; }
  try {
    const rq = new Request(url);
    rq.timeoutInterval = 15;
    const d = await rq.loadJSON();
    if (!d || !d.version) throw new Error('version.json ohne „version“');
    updateInfo = { version: String(d.version), zip: String(d.zip || ''), notes: String(d.notes || '').slice(0, 2000) };
    const newer = cmpVersion(updateInfo.version, VERSION) > 0;
    step('Update-Prüfung: installiert ' + VERSION + ', verfügbar ' + updateInfo.version + (newer ? ' (neuer)' : ''));
    return { state: newer ? 'newer' : 'current', current: VERSION, version: updateInfo.version, notes: updateInfo.notes };
  } catch (e) {
    step('Update-Prüfung fehlgeschlagen: ' + e);
    return { state: 'error', current: VERSION, msg: String(e.message || e) };
  }
}
async function downloadUpdate() {
  if (!updateInfo || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(updateInfo.zip)) throw new Error('Keine Download-Adresse');
  const rq = new Request(updateInfo.zip);
  rq.timeoutInterval = 120;
  const data = await rq.load();
  const dir = fm.joinPath(root, 'updates');
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, 'ScriptSCAD-' + updateInfo.version.replace(/[^\w.\-]/g, '_') + '.zip');
  if (fm.fileExists(path)) fm.remove(path);
  fm.write(path, data);
  step('Update geladen: ' + path.slice(root.length + 1) + ' (' + Math.round(data.getBytes().length / 1024) + ' KB)');
  return path;
}
// ---------- 10i: Teile im Projekt (projects/<Ordner>/teile/) – in OpenSCAD per import("name.stl") nutzbar ----------
const PART_RE = /\.(stl|off|obj|3mf|svg|dxf)$/i;
const PART_MAX_MB = 25;
const partsDir = (id) => fm.joinPath(projectDir(id), 'teile');
function partNames(id) {
  const d = partsDir(id);
  try { return fm.fileExists(d) ? fm.listContents(d).filter((n) => PART_RE.test(n)).sort() : []; } catch (e) { return []; }
}
const partFileName = (n) => String(n).replace(/[^A-Za-z0-9äöüÄÖÜß._\- ]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'teil.stl';
// alle Teile des Projekts an die Seite (vor dem ersten Rendern, sonst findet import() sie nicht)
async function sendParts(wv, id) {
  const names = partNames(id);
  await run(wv, 'App.partsBegin(' + js(id) + ')', false, 5000, 'Teile');
  let bytes = 0;
  for (const n of names) {
    const f = fm.joinPath(partsDir(id), n);
    try {
      await fm.downloadFileFromiCloud(f);
      const b64 = Data.fromFile(f).toBase64String();
      bytes += b64.length;
      for (let i = 0; i < b64.length; i += CHUNK) await run(wv, 'App.partAdd(' + js(n) + ',"' + b64.slice(i, i + CHUNK) + '")', false, 15000, 'Teil ' + n);
    } catch (e) { step('Teil nicht lesbar: ' + n + ' (' + e + ')'); }
  }
  await run(wv, 'App.partsDone(' + js(js(names)) + ')', false, 10000, 'Teile');
  if (names.length) step('Teile übertragen: ' + names.join(', ') + ' (' + Math.round((bytes * 3) / 4 / 1024) + ' KB)');
}
// Für den KI-Prompt: welche Teile gibt es (mit Maßen bei STL)
function partsPromptNote(id) {
  const names = partNames(id);
  if (!names.length) return '';
  const lines = names.map((n) => {
    let d = '';
    if (/\.stl$/i.test(n)) { try { const s = stlSummary(Data.fromFile(fm.joinPath(partsDir(id), n))); if (s.ok) d = ' – ' + s.text; } catch (e) { /* ohne Maße */ } }
    return '- import("' + n + '")' + d;
  });
  return fmt(T.partsPromptHead, { list: lines.join('\n') });
}
// STL des Projekts nach projects/<Ordner>/export/<Name>.stl (überschreibt die vorige)
async function writeStl(id, stl) {
  const meta = await readMeta(id);
  const dir = fm.joinPath(projectDir(id), 'export');
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const file = safeFileName(meta.name) + '.stl';
  const path = fm.joinPath(dir, file);
  if (fm.fileExists(path)) fm.remove(path);
  fm.writeString(path, String(stl));
  step('STL exportiert: ' + id + '/export/' + file + ' (' + Math.round(String(stl).length / 1024) + ' KB)');
  return { file, path };
}
async function handle(wv, a) {
  if (a.id != null) await store.dirOf(a.id); // Zuordnung Kennung → Ordner bei Bedarf neu lesen
  switch (a.type) {
    case 'log':
      step('Seite: ' + String(a.text).slice(0, 2000));
      return;
    case 'list':
      await sendList(wv);
      return;
    case 'create': {
      const id = await createProject(a.name, ''); // 10n: neues Projekt ist leer
      step('Projekt angelegt: ' + id);
      await sendList(wv);
      await run(wv, 'App.toast(' + js(fmt(T.created, { name: cleanName(a.name) })) + ')');
      return;
    }
    case 'addPart': {
      // 10i: STL (oder OFF/OBJ/3MF/SVG/DXF) aus der Dateien-App ins Projekt kopieren → teile/<Name>
      let paths;
      try { paths = await DocumentPicker.open(); } catch (e) { step('Teil: abgebrochen (' + e + ')'); return; }
      const added = [], problems = [];
      for (const p of paths || []) {
        const name = partFileName(String(p).split('/').pop());
        if (!PART_RE.test(name)) { problems.push(fmt(T.partWrongType, { name })); continue; }
        try {
          let kb = null;
          try { kb = FileManager.local().fileSize(p); } catch (e) { /* unbekannt */ }
          if (kb != null && kb > PART_MAX_MB * 1024) { problems.push(fmt(T.uploadTooBig, { name, mb: PART_MAX_MB })); continue; }
          const data = Data.fromFile(p);
          if (!data) { problems.push(fmt(T.uploadUnreadable, { name })); continue; }
          if (!fm.fileExists(partsDir(a.id))) fm.createDirectory(partsDir(a.id), true);
          const target = fm.joinPath(partsDir(a.id), name);
          if (fm.fileExists(target)) fm.remove(target);
          fm.write(target, data);
          added.push(name);
        } catch (e) { step('Teil-Fehler ' + name + ': ' + e); problems.push(fmt(T.uploadUnreadable, { name })); }
      }
      step('Teile hinzugefügt: ' + (added.join(', ') || '–') + (problems.length ? ' · Probleme: ' + problems.join('; ') : ''));
      if (added.length) await sendParts(wv, a.id);
      await run(wv, 'App.partsAdded(' + js(js({ added, problems })) + ')', false, 10000, 'Teile');
      return;
    }
    case 'duplicate': {
      const meta = await readMeta(a.id);
      const code = await readText(fm.joinPath(projectDir(a.id), 'model.scad'));
      const name = cleanName(fmt(T.copySuffix, { name: meta.name }));
      const id = await createProject(name, code);
      const presetsSrc = fm.joinPath(projectDir(a.id), 'model.json'); // Vorlagen (7h) mitnehmen
      if (fm.fileExists(presetsSrc)) { try { fm.writeString(fm.joinPath(projectDir(id), 'model.json'), await readText(presetsSrc)); } catch (e) { step('Vorlagen nicht kopiert: ' + e); } }
      for (const n of partNames(a.id)) { // 10i: Teile mitnehmen
        try { if (!fm.fileExists(partsDir(id))) fm.createDirectory(partsDir(id), true); fm.copy(fm.joinPath(partsDir(a.id), n), fm.joinPath(partsDir(id), n)); } catch (e) { step('Teil nicht kopiert: ' + n + ' (' + e + ')'); }
      }
      step('Projekt dupliziert: ' + a.id + ' → ' + id);
      await sendList(wv);
      await run(wv, 'App.toast(' + js(fmt(T.duplicated, { name })) + ')');
      return;
    }
    case 'rename': {
      const meta = await readMeta(a.id);
      meta.name = cleanName(a.name);
      meta.modified = new Date().toISOString();
      writeMeta(a.id, meta);
      const folder = await store.renameFolder(a.id, meta.name);
      step('Projekt umbenannt: ' + a.id + ' → ' + meta.name + ' (Ordner „' + folder + '“)');
      await sendList(wv);
      await run(wv, 'App.toast(' + js(fmt(T.renamed, { name: meta.name })) + ')');
      return;
    }
    case 'delete': {
      const meta = await readMeta(a.id);
      if (meta.kind === 'test') throw new Error(T.testCubeNoDelete); // 10n
      if (!fm.fileExists(trashDir)) fm.createDirectory(trashDir, true);
      const folder = await store.folderOf(a.id);
      let target = fm.joinPath(trashDir, folder);
      if (fm.fileExists(target)) target = fm.joinPath(trashDir, folder + '-' + Date.now());
      fm.move(projectDir(a.id), target);
      await store.remove(a.id);
      step('Projekt in Papierkorb: ' + a.id);
      await sendList(wv);
      await run(wv, 'App.toast(' + js(fmt(T.deleted, { name: meta.name })) + ')');
      return;
    }
    case 'save': {
      let res;
      try {
        const meta = await readMeta(a.id);
        fm.writeString(fm.joinPath(projectDir(a.id), 'model.scad'), String(a.code));
        meta.modified = new Date().toISOString();
        writeMeta(a.id, meta);
        step('Gespeichert: ' + a.id + ' (' + String(a.code).length + ' Zeichen)' + (a.snapshot ? ', mit Version' : ''));
        if (a.snapshot) await snapshot(a.id, String(a.code));
        res = { id: a.id, seq: a.seq, ok: true };
      } catch (e) {
        step('FEHLER beim Speichern ' + a.id + ': ' + e);
        res = { id: a.id, seq: a.seq, ok: false, error: String(e.message || e) };
      }
      await run(wv, 'App.saved(' + js(js(res)) + ')', false, 10000, 'Speichern bestätigen');
      return;
    }
    case 'exportStl': {
      const { file, path } = await writeStl(a.id, a.stl);
      await run(wv, 'App.stlSaved(' + js(js({ id: a.id, file, path })) + ')', false, 10000, 'STL bestätigen');
      return;
    }
    case 'openSlicer': {
      // 9i: STL schreiben und den Slicer im selben Skript starten. Sein Fenster legt sich über Studio;
      // wird es geschlossen, ist man wieder in Studio (Studio wartet so lange).
      await writeStl(a.id, a.stl);
      const slicerMain = fm.joinPath(appDir, 'slicer-main.js');
      if (!fm.fileExists(slicerMain)) { await run(wv, 'App.toast(' + js(T.slicerMissing) + ')'); return; }
      const src = await readText(slicerMain);
      const res = { opened: false };
      step('Slicer starten mit Projekt ' + a.id);
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        await new AsyncFunction('STARTER', src)({ version: 'Studio ' + VERSION, root, fm, open: a.id, result: res });
      } catch (e) { step('FEHLER im Slicer: ' + e + (e && e.line ? ' (slicer-main.js, Zeile ' + e.line + ')' : '')); }
      step('Slicer beendet (' + (res.opened ? 'Fenster war offen' : 'Fenster NICHT geöffnet') + '), zurück in Studio');
      // 10d: Im Slicer geänderte Sprache/Darstellung (settings.json) auch in Studio übernehmen
      try {
        const s = readSettings();
        if (I18N_ALL[effLang(s)] !== T) T = I18N_ALL[effLang(s)];
        await run(wv, 'App.setSettings(' + js(js(Object.assign(cleanSettings(s), { sysLang: SYS_LANG }))) + ')', false, 5000, 'Einstellungen');
      } catch (e) { step('Einstellungen nach dem Slicer nicht übernommen: ' + e); }
      await run(wv, 'App.status(' + js(res.opened ? T.slicerBack : '') + ')').catch(() => {});
      if (!res.opened) await run(wv, 'App.toast(' + js(T.slicerFailed) + ')').catch(() => {});
      return;
    }
    case 'checkUpdate': {
      const r = await checkUpdate(wv);
      await run(wv, 'App.updateResult(' + js(js(r)) + ')', false, 10000, 'Update');
      return;
    }
    case 'downloadUpdate': {
      let r;
      try { const path = await downloadUpdate(); r = { ok: true, path, rel: path.slice(root.length + 1), version: updateInfo.version }; } catch (e) { step('Update-Download fehlgeschlagen: ' + e); r = { ok: false, msg: String(e.message || e) }; }
      await run(wv, 'App.updateDownloaded(' + js(js(r)) + ')', false, 10000, 'Update');
      return;
    }
    case 'saveUpdateToFiles': {
      const p = String(a.path);
      if (p.indexOf(fm.joinPath(root, 'updates')) !== 0 || p.indexOf('..') >= 0 || !fm.fileExists(p)) throw new Error('Datei nicht gefunden: ' + p);
      try { const r = await DocumentPicker.export(p); step('Update in Dateien gesichert: ' + js(r)); } catch (e) { step('Update sichern abgebrochen: ' + e); }
      return;
    }
    case 'exportFiles': {
      // 10k: 3MF (base64) bzw. mehrere STL (Text) nach projects/<Ordner>/export/
      const dir = fm.joinPath(projectDir(a.id), 'export');
      if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
      const files = [], paths = [];
      for (const f of (a.files || []).slice(0, 200)) {
        const name = safeFileName(String(f.name).replace(/\.(3mf|stl)$/i, '')) + (/\.3mf$/i.test(f.name) ? '.3mf' : '.stl');
        const path = fm.joinPath(dir, name);
        if (fm.fileExists(path)) fm.remove(path);
        if (f.b64 != null) fm.write(path, Data.fromBase64String(String(f.b64))); else fm.writeString(path, String(f.text || ''));
        files.push(name); paths.push(path);
      }
      step('Export: ' + files.join(', '));
      await run(wv, 'App.filesSaved(' + js(js({ id: a.id, folder: projectDir(a.id).split('/').pop(), files, paths })) + ')', false, 10000, 'Export bestätigen');
      return;
    }
    case 'openUrl': {
      // 10p: Spenden-Button. Nur die fest hinterlegte Ko-fi-Adresse wird geöffnet (keine beliebigen URLs aus der Seite).
      if (a.url !== 'https://ko-fi.com/darthquintus') { step('openUrl abgelehnt: ' + js(a.url).slice(0, 200)); return; }
      step('Safari öffnen: ' + a.url);
      try { Safari.open(a.url); } catch (e) { step('FEHLER Safari: ' + e); }
      return;
    }
    case 'share': {
      // Auf dem iPad getestet (2b.2): ShareSheet mit dem Dateipfad bietet die Datei an (Slicer-App erscheint).
      // Nicht geeignet: ShareSheet mit Data (leeres Menü), QuickLook-Vorschau. 10k: auch mehrere Pfade.
      const list = (Array.isArray(a.paths) ? a.paths : [a.path]).map(checkExportPath);
      const path = list.join(', ');
      step('Teilen-Menü öffnen: ' + path);
      try {
        const r = await ShareSheet.present(list);
        step('Teilen-Menü geschlossen: ' + js(r));
      } catch (e) {
        step('FEHLER Teilen: ' + e);
        await run(wv, 'App.toast(' + js(fmt(T.shareFailed, { msg: String(e.message || e) })) + ')');
      }
      return;
    }
    case 'saveToFiles': {
      const path = checkExportPath(a.path);
      step('In Dateien sichern: ' + path);
      try {
        const r = await DocumentPicker.export(path);
        step('In Dateien gesichert: ' + js(r));
        if (r && r.length) await run(wv, 'App.toast(' + js(T.savedToFiles) + ')');
      } catch (e) {
        step('In Dateien sichern abgebrochen/fehlgeschlagen: ' + e);
      }
      return;
    }
    case 'listHistory': {
      const list = [];
      for (const f of historyFiles(a.id).reverse()) {
        const code = await readText(fm.joinPath(historyDir(a.id), f));
        list.push({ file: f, lines: code.split('\n').length, chars: code.length });
      }
      await run(wv, 'App.showHistory(' + js(js({ id: a.id, list })) + ')', false, 10000, 'Versionen anzeigen');
      return;
    }
    case 'readHistory': {
      if (!HISTORY_RE.test(String(a.file))) throw new Error('Ungültige Version: ' + a.file);
      const code = await readText(fm.joinPath(historyDir(a.id), a.file));
      step('Version wiederhergestellt: ' + a.id + '/history/' + a.file);
      await run(wv, 'App.restoreVersion(' + js(js({ id: a.id, file: a.file, code })) + ')', false, 10000, 'Version laden');
      return;
    }
    case 'settings': {
      const s = Object.assign(readSettings(), cleanSettings(Object.assign(readSettings(), a.settings || {})));
      writeSettings(s);
      step('Einstellungen gespeichert: ' + js(cleanSettings(s)));
      if (I18N_ALL[effLang(s)] !== T) { T = I18N_ALL[effLang(s)]; step('Sprache: ' + effLang(s)); }
      await run(wv, 'App.setSettings(' + js(js(Object.assign(cleanSettings(s), { sysLang: SYS_LANG }))) + ')', false, 5000, 'Einstellungen');
      return;
    }
    case 'uiState': {
      // Ansichts-Zustand eines Projekts (z. B. zugeklappte Regler-Abschnitte) – ändert nicht das Änderungsdatum
      const meta = await readMeta(a.id);
      const collapsed = (Array.isArray(a.collapsed) ? a.collapsed : []).map((g) => String(g).slice(0, 100)).slice(0, 200);
      meta.ui = Object.assign({}, meta.ui, { collapsed });
      writeMeta(a.id, meta);
      return;
    }
    case 'aiSend':
      try {
        await aiSend(wv, a);
      } catch (e) {
        step('FEHLER KI-Anfrage: ' + e);
        await run(wv, 'App.aiResult(' + js(js({ ok: false, error: String(e.message || e) })) + ')', false, 10000, 'KI-Fehler');
      }
      return;
    case 'needFonts':
      await sendFonts(wv);
      return;
    case 'presetsSave': {
      // Vorlagen (7h): ganze Liste schreiben, Format des OpenSCAD-Customizers (model.json neben model.scad)
      const sets = a.sets && typeof a.sets === 'object' ? a.sets : {};
      fm.writeString(fm.joinPath(projectDir(a.id), 'model.json'), JSON.stringify({ parameterSets: sets, fileFormatVersion: '1' }, null, 2) + '\n');
      step('Vorlagen gespeichert: ' + Object.keys(sets).length + (a.note ? ' (' + String(a.note).slice(0, 80) + ')' : ''));
      return;
    }
    case 'needLib':
      await sendLib(wv, String(a.name || ''));
      return;
    case 'aiCopy':
      await aiCopy(wv, a);
      return;
    case 'copyCode':
      Pasteboard.copyString(String(a.code || ''));
      step('Code kopiert (' + String(a.code || '').length + ' Zeichen)');
      await run(wv, 'App.toast(' + js(T.copied) + ')');
      return;
    case 'pasteCode': {
      // Kopierte KI-Antwort (z. B. aus der Claude-App) → Codeblock herausziehen wie bei KI-Antworten; reiner Code bleibt, wie er ist
      const text = Pasteboard.pasteString();
      if (!text || !text.trim()) { await run(wv, 'App.toast(' + js(T.pasteEmpty) + ')'); return; }
      const isAnswer = text.includes('```') || looksFlat(text);
      const ex = isAnswer ? extractCode(text) : null;
      const code = ex ? ex.code : text.replace(/\s+$/, '') + '\n';
      step('Code eingefügt (' + text.length + ' Zeichen' + (ex ? ', Codeblock aus Antwort' : '') + ')');
      await run(wv, 'App.pasteCode(' + js(js({ code, extracted: !!ex })) + ')', false, 10000, 'Einfügen');
      return;
    }
    case 'aiPickFile':
      await aiPickFile(wv, a.source === 'photos' ? 'photos' : 'files');
      return;
    case 'aiRemoveFile':
      removeUpload(a.file);
      return;
    case 'aiClearFiles':
      clearUploads(pendingUploads());
      return;
    case 'saveViewToPhotos':
      await saveViewToPhotos(wv, a.image);
      return;
    case 'aiDecision': {
      const list = await updateAiHistory(a.id, String(a.reqId), { result: a.accepted ? 'accepted' : 'discarded' });
      step('KI-Vorschlag ' + a.reqId + (a.accepted ? ' übernommen' : ' verworfen'));
      await run(wv, 'App.setAiHistory(' + js(js({ id: a.id, list })) + ')', false, 10000, 'KI-Verlauf');
      return;
    }
    case 'open': {
      const meta = await readMeta(a.id);
      const code = await readText(fm.joinPath(projectDir(a.id), 'model.scad'));
      step('Projekt geöffnet: ' + a.id + ' (' + code.length + ' Zeichen)');
      if (!historyFiles(a.id).length) await snapshot(a.id, code); // Ausgangsstand sichern
      const collapsed = meta.ui && Array.isArray(meta.ui.collapsed) ? meta.ui.collapsed : [];
      const presets = await readPresets(a.id);
      await sendParts(wv, a.id); // 10i: Teile vor dem ersten Rendern
      await run(wv, 'App.openProject(' + js(js({ id: a.id, name: meta.name, code, collapsed, presets })) + ')', false, 10000, 'Projekt öffnen');
      await run(wv, 'App.setAiHistory(' + js(js({ id: a.id, list: await readAiHistory(a.id) })) + ')', false, 10000, 'KI-Verlauf');
      if (openscadLoaded) await recoverAi(wv, a.id);
      const s = readSettings();
      s.lastProject = a.id;
      writeSettings(s);
      return;
    }
    default:
      step('Unbekannte Aktion: ' + js(a).slice(0, 200));
  }
}

// ---------- Vorlagen (7h) ----------
async function readPresets(id) {
  const f = fm.joinPath(projectDir(id), 'model.json');
  if (!fm.fileExists(f)) return null;
  try { return JSON.parse(await readText(f)); } catch (e) { step('Vorlagen (model.json) nicht lesbar: ' + e); return null; }
}

// ---------- Fremdbibliotheken (7g) ----------
// Die Seite fragt erst, wenn ein Code include/use <BOSL2/…>, <MCAD/…> oder <NopSCADlib/…> enthält.
// Paketdatei = JSON-Text { "BOSL2/std.scad": Inhalt, … } → in Stücken als Text an die Seite, dort zusammengesetzt und gelesen.
async function sendLib(wv, name) {
  const t = Date.now();
  let text = '';
  if (LIB_NAMES.includes(name)) {
    const f = fm.joinPath(libsDir, name + '.json');
    try {
      if (fm.fileExists(f)) { await fm.downloadFileFromiCloud(f); text = fm.readString(f) || ''; }
    } catch (e) { step('FEHLER Bibliothek ' + name + ' nicht lesbar: ' + e); text = ''; }
  }
  try {
    for (let i = 0; i < text.length; i += CHUNK) await run(wv, 'App.libAdd(' + js(name) + ',' + js(text.slice(i, i + CHUNK)) + ')', false, 15000, 'Bibliothek ' + name);
  } catch (e) {
    step('FEHLER Bibliothek ' + name + ' übertragen: ' + e);
    text = '';
  }
  await run(wv, 'App.libDone(' + js(name) + ',' + (text ? 1 : 0) + ')', false, 30000, 'Bibliothek ' + name);
  step('Bibliothek ' + name + (text ? ' übertragen: ' + Math.round(text.length / 1024) + ' KB, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s' : ' fehlt (Ordner ScriptSCAD/bibliotheken)'));
  if (!text) await run(wv, 'App.toast(' + js(T.libMissing.replace('{name}', name)) + ')');
}

// ---------- Schriftarten für text() (7f) ----------
// Die Seite fragt erst, wenn ein Code text( enthält → Start bleibt so schnell wie vorher.
async function sendFonts(wv) {
  const t = Date.now();
  let names = [];
  try { if (fm.fileExists(fontsDir)) names = fm.listContents(fontsDir).filter((n) => /\.(ttf|otf)$/i.test(n)).sort(); } catch (e) { step('Schriftarten nicht lesbar: ' + e); }
  let bytes = 0;
  try {
    for (const n of names) {
      const f = fm.joinPath(fontsDir, n);
      await fm.downloadFileFromiCloud(f);
      const b64 = Data.fromFile(f).toBase64String();
      bytes += b64.length;
      for (let i = 0; i < b64.length; i += CHUNK) await run(wv, 'App.fontAdd(' + js(n) + ',"' + b64.slice(i, i + CHUNK) + '")', false, 15000, 'Schrift ' + n);
    }
  } catch (e) {
    step('FEHLER Schriftarten: ' + e); // Seite trotzdem freigeben (text() bleibt dann leer)
  }
  await run(wv, 'App.fontsDone(' + names.length + ')', false, 15000, 'Schriftarten');
  step('Schriftarten übertragen: ' + names.length + ' Dateien, ' + Math.round((bytes / 4) * 3 / 1024) + ' KB, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s');
  if (!names.length) await run(wv, 'App.toast(' + js(T.fontsMissing) + ')');
}

// ---------- OpenSCAD übertragen ----------
async function loadOpenscad(wv, isClosed) {
  const t = Date.now();
  const b64 = Data.fromFile(fm.joinPath(appDir, 'lib/openscad.wasm')).toBase64String();
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - padding;
  const count = Math.ceil(b64.length / CHUNK);
  await run(wv, 'App.wasmBegin(' + bytes + ')', false, 10000, 'Übertragung beginnen');
  for (let i = 0, n = 1; i < b64.length; i += CHUNK, n++) {
    if (isClosed()) throw new Error('Ansicht wurde geschlossen');
    await run(wv, 'App.wasmAdd("' + b64.slice(i, i + CHUNK) + '")', false, 15000, 'Stück ' + n + '/' + count);
  }
  step('OpenSCAD übertragen: ' + bytes + ' Bytes in ' + count + ' Stücken, ' + ((Date.now() - t) / 1000).toFixed(2) + ' s');
  const res = JSON.parse(await run(wv, 'App.wasmFinish().then(completion)', true, 90000, 'Vorbereiten'));
  if (res.error) throw new Error('Vorbereiten: ' + res.error);
  step('OpenSCAD bereit (kompiliert in ' + res.compileMs + ' ms)');
}

// ---------- Ablauf ----------
let ok = false;
let openscadLoaded = false;
let openedAtStart = null;
async function main() {
  step('Start ' + VERSION + ' (' + STARTER.version + '). Gerät: ' + Device.model() + ', iOS ' + Device.systemVersion());
  const sysFirst = detectLang();
  T = I18N_ALL[effLang(readSettings())];
  step('Sprache: ' + effLang(readSettings()) + ' (System: ' + (sysFirst || '?') + ' → ' + SYS_LANG + (readSettings().lang ? ', gewählt: ' + readSettings().lang : ', nicht gewählt') + ')');
  const missing = APP_FILES.filter((f) => !fm.fileExists(fm.joinPath(appDir, f)));
  if (missing.length) {
    step('Dateien fehlen: ' + missing.join(', '));
    await showAlert(fmt(T.filesMissing, { list: missing.join('\n') }));
    ok = true;
    return;
  }
  for (const f of APP_FILES) await fm.downloadFileFromiCloud(fm.joinPath(appDir, f));
  store = new Function((await readText(fm.joinPath(appDir, 'projekte.js'))) + '\nreturn ProjectStore;')()(fm, root, step);
  const moved = await store.migrate(); // 9e.3: alte Ordner „p2026…“ → Projektname
  if (moved) step('Projektordner umbenannt: ' + moved);
  await ensureProjects();

  const wv = new WebView();
  await wv.loadFile(fm.joinPath(appDir, 'index.html'));
  const pageVersion = await run(wv, 'completion(App.version())', true, 5000, 'Version der Oberfläche');
  step('Seite geladen, Oberfläche ' + pageVersion);
  await run(wv, 'App.setVersion(' + js(VERSION) + ')', false, 5000, 'Version');
  await run(wv, 'App.setLang(' + js(effLang(readSettings())) + ')', false, 5000, 'Sprache');
  // OpenSCAD-Bibliothek (7e): alle .scad aus app/bibliothek an die Seite → dort bei jedem Rendern neben /input.scad (use <scriptscad.scad>)
  const libDir = fm.joinPath(appDir, 'bibliothek');
  const scadLib = {};
  for (const f of fm.listContents(libDir).filter((n) => /\.scad$/.test(n))) {
    await fm.downloadFileFromiCloud(fm.joinPath(libDir, f));
    scadLib[f] = fm.readString(fm.joinPath(libDir, f));
  }
  await run(wv, 'App.setScadLib(' + js(js(scadLib)) + ')', false, 10000, 'Bibliothek');
  step('Bibliothek: ' + Object.keys(scadLib).map((f) => f + ' (' + scadLib[f].length + ' Zeichen)').join(', '));

  let closed = false;
  const closedPromise = wv.present(true).then(() => {
    closed = true;
    signalClosed(new Error('Ansicht wurde geschlossen'));
    return null;
  });
  await sleep(1200); // Öffnen-Animation abwarten (Schritt 1)
  await run(wv, 'App.ready().then(completion)', true, 15000, 'Oberfläche zeichnen');
  step('Oberfläche gezeichnet: ' + (await run(wv, 'completion(App.diag())', true, 5000, 'Diagnose')));
  await sendList(wv);
  // Darstellung des iPads (für „Automatisch“); die WebView meldet sie ggf. zusätzlich selbst
  try { await run(wv, 'App.setDeviceDark(' + js(!!Device.isUsingDarkAppearance()) + ')', false, 5000, 'Darstellung'); } catch (e) { step('Darstellung nicht abfragbar: ' + e); }
  const settings = readSettings();
  await run(wv, 'App.setSettings(' + js(js(Object.assign(cleanSettings(settings), { sysLang: SYS_LANG }))) + ')', false, 5000, 'Einstellungen');
  if (settings.openLast && settings.lastProject && (await store.dirOf(settings.lastProject))) {
    try { await handle(wv, { type: 'open', id: settings.lastProject }); openedAtStart = settings.lastProject; } catch (e) { step('Letztes Projekt nicht geöffnet: ' + e); }
  }

  try {
    await loadOpenscad(wv, () => closed);
  } catch (e) {
    step('FEHLER beim Laden von OpenSCAD: ' + e);
    if (!closed) await run(wv, 'App.status(' + js(fmt(T.error, { msg: String(e) })) + ', true)', false, 5000).catch(() => {});
  }
  openscadLoaded = true;
  ok = true;
  // Nicht abgeholte KI-Antwort: im offenen Projekt sofort anbieten, sonst Hinweis in der Projektliste
  const pend = pendingAnswer();
  if (pend && !closed) {
    if (openedAtStart === pend.project) await recoverAi(wv, pend.project);
    else {
      let name = pend.projectName || pend.project;
      await run(wv, 'App.toast(' + js(fmt(T.aiPendingHint, { name })) + ')', false, 5000, 'Hinweis');
      step('Nicht abgeholte KI-Antwort für ' + pend.project + ' – Hinweis gezeigt');
    }
  }

  // Aktionen abfragen, bis die Ansicht geschlossen wird.
  // 7f.2 (iPhone): Ist Scriptable im Hintergrund (z. B. Wechsel zur Claude-App), antwortet die Ansicht nicht → Zeitüberschreitung.
  // Früher brach die Schleife dann ab und kein Knopf funktionierte mehr. Jetzt: weiter abfragen, bis die Ansicht geschlossen wird.
  // Aktionen tragen eine Nummer (_id) und bleiben in der Seite, bis Scriptable sie bestätigt (ack) → eine verspätet ausgeführte
  // Abfrage kann keine Aktion „verschlucken“, doppelte werden übersprungen.
  let polls = 0;
  let ack = 0;
  let fails = 0;
  let failSince = 0;
  while (!closed) {
    await Promise.race([sleep(400), closedPromise]);
    if (closed) break;
    let reply;
    try {
      reply = JSON.parse(await run(wv, 'completion(App.poll(' + ack + '))', true, 10000, 'Abfrage'));
    } catch (e) {
      if (closed) break;
      if (!fails) failSince = Date.now();
      fails++;
      if (fails === 1 || fails % 30 === 0) step('Abfrage ohne Antwort (' + fails + '×, App im Hintergrund?): ' + e);
      await Promise.race([sleep(1000), closedPromise]);
      continue;
    }
    if (fails) { step('Abfrage wieder da nach ' + Math.round((Date.now() - failSince) / 1000) + ' s (' + fails + ' Fehlversuche)'); fails = 0; }
    polls++;
    if (polls === 3 || polls % 150 === 0) step('Ansicht: ' + js(reply.diag));
    for (const a of reply.actions) {
      if (typeof a._id === 'number') {
        if (a._id <= ack) continue; // schon erledigt
        ack = a._id;
      }
      try {
        await handle(wv, a);
      } catch (e) {
        step('FEHLER bei Aktion ' + a.type + ': ' + e);
        if (!closed) await run(wv, 'App.toast(' + js(fmt(T.actionFailed, { msg: String(e.message || e) })) + ')').catch(() => {});
      }
    }
  }
  await closedPromise;
  step('Ansicht geschlossen');
}

try {
  await main();
} catch (e) {
  step('FEHLER: ' + e + (e && e.line ? ' (Zeile ' + e.line + ')' : ''));
}
if (!ok) await showAlert(fmt(T.reportIntro, { lines: logLines.slice(-8).join('\n') }));
