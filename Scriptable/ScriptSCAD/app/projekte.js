// ScriptSCAD – gemeinsame Projektordner für Studio und Slicer (Schritt 9e.3). Läuft in Scriptable (main.js, slicer-main.js) und in Node-Tests.
// Wird als Text gelesen: new Function(text + '\nreturn ProjectStore;')().
//
// Regeln:
//  - Ordnername = lesbarer Projektname (projects/Halter/), bei Gleichstand „Name (2)“. Groß/Klein zählt nicht (iCloud/APFS).
//  - Die feste Kennung steht in project.json → id (alte Ordner „p20261106-143432“: Kennung = alter Ordnername).
//    Alle Verweise (settings.json, KI-Verlauf, Druckplatten) nutzen die Kennung, nie den Ordnernamen.
//  - Studio-Projekt = Ordner mit model.scad. Reines Slicer-Projekt = Ordner mit platte.json ohne model.scad.
function ProjectStore(fm, root, log) {
  'use strict';
  const projectsDir = fm.joinPath(root, 'projects');
  const OLD = /^p\d{8}-\d{6}(-\d+)?$/;
  log = log || function () {};

  // Erlaubter Ordnername aus einem Projektnamen
  function folderName(name) {
    let s = String(name == null ? '' : name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, '').trim().slice(0, 60).trim();
    return s || 'Projekt';
  }
  function folders() {
    if (!fm.fileExists(projectsDir)) return [];
    return fm.listContents(projectsDir).filter((n) => { try { return fm.isDirectory(fm.joinPath(projectsDir, n)); } catch (e) { return false; } });
  }
  // Freier Ordnername (ohne Unterschied Groß/Klein); keep = Ordner, der seinen eigenen Namen behalten darf
  function uniqueFolder(name, keep) {
    const base = folderName(name);
    const used = new Set(folders().filter((f) => f !== keep).map((f) => f.toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) { const c = base + ' (' + n + ')'; if (!used.has(c.toLowerCase())) return c; }
  }
  async function readJson(path) {
    try { await fm.downloadFileFromiCloud(path); } catch (e) { /* lokal vorhanden */ }
    return JSON.parse(fm.readString(path));
  }

  // Kennung → Ordnername (aus allen project.json gelesen)
  let map = null;
  async function index(force) {
    if (map && !force) return map;
    const m = new Map();
    for (const f of folders()) {
      const pj = fm.joinPath(fm.joinPath(projectsDir, f), 'project.json');
      if (!fm.fileExists(pj)) continue;
      try {
        const meta = await readJson(pj);
        const id = String(meta.id || f);
        if (m.has(id)) { log('Doppelte Kennung ' + id + ': ' + m.get(id) + ' und ' + f + ' (zweiter Ordner übersprungen)'); continue; }
        m.set(id, f);
      } catch (e) { log('project.json nicht lesbar: ' + f + ' (' + e + ')'); }
    }
    map = m;
    return m;
  }
  function forget() { map = null; }
  // Ordnerpfad zu einer Kennung (null, wenn unbekannt)
  async function dirOf(id) {
    let m = await index();
    if (!m.has(String(id))) m = await index(true);
    const f = m.get(String(id));
    return f ? fm.joinPath(projectsDir, f) : null;
  }
  // ohne Warten: nur gültig nach index() (Studio ruft index() beim Start und nach jeder Änderung auf)
  function dirSync(id) { const f = map && map.get(String(id)); return f ? fm.joinPath(projectsDir, f) : null; }
  async function folderOf(id) { const d = await dirOf(id); return d ? d.slice(projectsDir.length + 1) : null; }
  async function ids() { return Array.from((await index()).keys()); }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  async function newId() {
    const m = await index();
    const s = 'p' + stamp();
    let id = s;
    for (let n = 2; m.has(id); n++) id = s + '-' + n;
    return id;
  }
  // Neuen Projektordner anlegen → { id, dir, folder }; extra = weitere Felder für project.json (z. B. kind: 'plate')
  async function create(name, extra) {
    if (!fm.fileExists(projectsDir)) fm.createDirectory(projectsDir, true);
    const id = await newId();
    const folder = uniqueFolder(name);
    const dir = fm.joinPath(projectsDir, folder);
    fm.createDirectory(dir, true);
    const now = new Date().toISOString();
    fm.writeString(fm.joinPath(dir, 'project.json'), JSON.stringify(Object.assign({ version: 1, id, name: String(name), created: now, modified: now }, extra || {}), null, 2));
    (await index()).set(id, folder);
    return { id, dir, folder };
  }
  // Ordner an den (neuen) Projektnamen anpassen. Scheitert das Umbenennen, bleibt der alte Ordner gültig (Kennung zählt).
  async function renameFolder(id, name) {
    const m = await index();
    const old = m.get(String(id));
    if (!old) return null;
    const want = uniqueFolder(name, old);
    if (want === old) return old;
    const from = fm.joinPath(projectsDir, old);
    try {
      if (want.toLowerCase() === old.toLowerCase()) {
        // nur Groß/Klein geändert: über einen Zwischennamen (Dateisystem unterscheidet nicht)
        const tmp = fm.joinPath(projectsDir, uniqueFolder(want + ' ~'));
        fm.move(from, tmp);
        fm.move(tmp, fm.joinPath(projectsDir, want));
      } else fm.move(from, fm.joinPath(projectsDir, want));
      m.set(String(id), want);
      return want;
    } catch (e) {
      log('Ordner nicht umbenannt: ' + old + ' → ' + want + ' (' + e + ')');
      forget();
      return old;
    }
  }
  async function remove(id) { const m = await index(); m.delete(String(id)); }

  // Einmaliger Umzug: alte Ordner „pJJJJMMTT-HHMMSS“ → Projektname; Kennung in project.json festhalten.
  // Läuft bei jedem Start (Studio und Slicer); ohne alte Ordner passiert nichts.
  async function migrate() {
    const old = folders().filter((f) => OLD.test(f) && fm.fileExists(fm.joinPath(fm.joinPath(projectsDir, f), 'project.json')));
    let moved = 0;
    const plan = [];
    for (const f of old) {
      const dir = fm.joinPath(projectsDir, f);
      const pj = fm.joinPath(dir, 'project.json');
      try {
        const meta = await readJson(pj);
        if (meta.id && meta.id !== f) continue; // trägt schon eine andere Kennung: kein alter Ordner
        const name = String(meta.name || '').trim();
        if (!name) continue;
        plan.push({ f, dir, pj, meta, name });
      } catch (e) { log('Umzug: project.json nicht lesbar: ' + f + ' (' + e + ')'); }
    }
    if (!plan.length) return 0;
    // Zuordnung vorab sichern (falls etwas schiefgeht, lässt sich nachvollziehen, was wohin sollte)
    try {
      const file = fm.joinPath(projectsDir, 'umzug-9e3.json');
      let prev = [];
      try { if (fm.fileExists(file)) prev = JSON.parse(fm.readString(file)).ordner || []; } catch (e) { /* neu anlegen */ }
      fm.writeString(file, JSON.stringify({ hinweis: 'Umzug der Projektordner auf lesbare Namen (9e.3). Kennung = alter Ordnername.', ordner: prev.concat(plan.map((p) => ({ kennung: p.f, name: p.name, zeit: new Date().toISOString() }))) }, null, 1));
    } catch (e) { log('Umzug: Sicherung der Zuordnung nicht geschrieben (' + e + ')'); }
    for (const p of plan) {
      try {
        if (!p.meta.id) { p.meta.id = p.f; fm.writeString(p.pj, JSON.stringify(p.meta, null, 2)); }
        const want = uniqueFolder(p.name, p.f);
        if (want !== p.f) { fm.move(p.dir, fm.joinPath(projectsDir, want)); moved++; log('Umzug: ' + p.f + ' → ' + want); }
      } catch (e) { log('Umzug fehlgeschlagen: ' + p.f + ' (' + e + ') – Ordner bleibt, Projekt funktioniert weiter'); }
    }
    forget();
    return moved;
  }

  return { projectsDir, folderName, uniqueFolder, folders, index, forget, dirOf, dirSync, folderOf, ids, newId, create, renameFolder, remove, migrate, OLD };
}
if (typeof module !== 'undefined' && module.exports) module.exports = ProjectStore;
