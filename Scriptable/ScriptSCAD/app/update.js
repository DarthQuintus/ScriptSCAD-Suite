// ScriptSCAD – Update-Prüfung (10l) für Studio (main.js) und Slicer (slicer-main.js), seit 10p.3 gemeinsam. Läuft in Scriptable.
// Wird als Text gelesen: new Function(text + '\nreturn ScriptSCADUpdate;')()(fm, root, appDir, VERSION, step, readText).
// Nur auf Knopfdruck, lädt nur auf Wunsch. Quelle: app/update-quelle.json → { url } einer version.json { version, zip, notes }. Leer = noch nicht eingerichtet.
function ScriptSCADUpdate(fm, root, appDir, VERSION, step, readText) {
  'use strict';
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
  async function saveToFiles(p) {
    p = String(p);
    if (p.indexOf(fm.joinPath(root, 'updates')) !== 0 || p.indexOf('..') >= 0 || !fm.fileExists(p)) throw new Error('Datei nicht gefunden: ' + p);
    try { const r = await DocumentPicker.export(p); step('Update in Dateien gesichert: ' + JSON.stringify(r)); } catch (e) { step('Update sichern abgebrochen: ' + e); }
  }
  // Aktionen der Seite (gleich in beiden Apps): checkUpdate → App.updateResult, downloadUpdate → App.updateDownloaded, saveUpdateToFiles
  async function handle(a, send) {
    if (a.type === 'checkUpdate') { await send('updateResult', await checkUpdate()); return true; }
    if (a.type === 'downloadUpdate') {
      let r;
      try { const path = await downloadUpdate(); r = { ok: true, path, rel: path.slice(root.length + 1), version: updateInfo.version }; } catch (e) { step('Update-Download fehlgeschlagen: ' + e); r = { ok: false, msg: String(e.message || e) }; }
      await send('updateDownloaded', r);
      return true;
    }
    if (a.type === 'saveUpdateToFiles') { await saveToFiles(a.path); return true; }
    return false;
  }
  return { cmpVersion, checkUpdate, downloadUpdate, saveToFiles, handle };
}
