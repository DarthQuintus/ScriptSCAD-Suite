// Lädt die Druckerprofile („machine“) aus OrcaSlicer (resources/profiles, AGPL-3.0) und schreibt die aufgelösten Maschinenwerte nach
// tools/daten/orca-maschinen.json. Daraus baut tools/build-slicer.mjs die Druckerbibliothek (app/slicer/drucker.json).
// Nur im Container nötig (braucht Internet: raw.githubusercontent.com, über curl wegen des Proxys). Aufruf: node tools/fetch-orca-profiles.mjs
// Ergebnis wird eingecheckt → der Bau der App klappt auch ohne Internet.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/SoftFever/OrcaSlicer/main/resources/profiles/';
// Hersteller-Dateien (<Name>.json) in OrcaSlicer, Stand 2026-11-22 (Verzeichnisliste ist aus dem Container nicht abrufbar → geprüfte Liste)
const VENDORS = ['Afinia', 'Anker', 'Anycubic', 'Artillery', 'BBL', 'BIQU', 'Blocks', 'CONSTRUCT3D', 'Chuanying', 'Co Print', 'Comgrow', 'Creality',
  'Cubicon', 'Custom', 'DeltaMaker', 'Dremel', 'Elegoo', 'Eryone', 'FLSun', 'Flashforge', 'FlyingBear', 'Folgertech', 'Geeetech', 'Ginger Additive',
  'InfiMech', 'Kingroon', 'Lulzbot', 'M3D', 'MagicMaker', 'Mellow', 'OpenEYE', 'OrcaArena', 'Peopoly', 'Phrozen', 'Positron3D', 'Prusa', 'Qidi',
  'Raise3D', 'Ratrig', 'RolohaunDesign', 'SecKit', 'Snapmaker', 'Sovol', 'Tiertime', 'Tronxy', 'TwoTrees', 'UltiMaker', 'Vivedino', 'Volumic',
  'Voron', 'Voxelab', 'Vzbot', 'Wanhao', 'Z-Bolt', 'iQ', 're3D'];

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
function get(url) {
  return new Promise((res) => execFile('curl', ['-sf', '-m', '60', '--retry', '3', url], { maxBuffer: 64 << 20 }, (err, out) => res(err ? null : out)));
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Felder, die wir brauchen (alles andere fällt weg)
const KEEP = ['printable_area', 'printable_height', 'bed_exclude_area', 'gcode_flavor', 'nozzle_diameter', 'retraction_length', 'retraction_speed', 'z_hop',
  'machine_start_gcode', 'machine_end_gcode', 'layer_change_gcode', 'before_layer_change_gcode', 'printer_model', 'printer_variant',
  'use_relative_e_distances', 'default_filament_profile', 'default_print_profile', 'auxiliary_fan', 'machine_max_speed_x', 'printer_structure', 'use_3mf'];

const result = { quelle: 'OrcaSlicer resources/profiles (main, abgerufen ' + new Date().toISOString().slice(0, 10) + ', AGPL-3.0)', maschinen: [], fehler: [] };
for (const vendor of VENDORS) {
  const idxText = await get(BASE + enc(vendor + '.json'));
  if (!idxText) { result.fehler.push(vendor + '.json'); console.log('FEHLT ' + vendor); continue; }
  const idx = JSON.parse(idxText);
  const files = {};
  const list = (idx.machine_list || []).concat(idx.machine_model_list || []);
  await pool(list, 12, async (m) => {
    const t = await get(BASE + enc(vendor + '/' + m.sub_path));
    if (!t) { result.fehler.push(vendor + '/' + m.sub_path); return; }
    try { files[m.name] = JSON.parse(t); } catch (e) { result.fehler.push(vendor + '/' + m.sub_path + ' (JSON)'); }
  });
  // Vererbung (inherits) + include (Vorlagen mit G-Code) auflösen
  const resolve = (name, seen = new Set()) => {
    const j = files[name];
    if (!j || seen.has(name)) return {};
    seen.add(name);
    const r = Object.assign({}, j.inherits ? resolve(j.inherits, seen) : {});
    for (const inc of [].concat(j.include || [])) Object.assign(r, resolve(inc, seen));
    for (const [k, v] of Object.entries(j)) if (!['inherits', 'include', 'name', 'type', 'from', 'instantiation', 'setting_id'].includes(k)) r[k] = v;
    return r;
  };
  let n = 0;
  for (const [name, j] of Object.entries(files)) {
    if (j.type !== 'machine' || String(j.instantiation) !== 'true') continue;
    const r = resolve(name);
    const model = files[r.printer_model] || {};
    const m = { vendor: idx.name || vendor, name, model: r.printer_model || name, model_id: model.model_id || '', default_bed_type: model.default_bed_type || '' };
    for (const k of KEEP) if (r[k] !== undefined) m[k] = r[k];
    result.maschinen.push(m);
    n++;
  }
  console.log(vendor + ': ' + n + ' Drucker (' + Object.keys(files).length + ' Dateien)');
}
const out = path.join(root, 'tools/daten');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'orca-maschinen.json'), JSON.stringify(result));
console.log('Gesamt: ' + result.maschinen.length + ' Druckerprofile, Fehler: ' + result.fehler.length + (result.fehler.length ? ' – ' + result.fehler.slice(0, 10).join(', ') : ''));
