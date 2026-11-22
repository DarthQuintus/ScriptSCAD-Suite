// Baut die Slicer-Bibliotheken für scriptable/ScriptSCAD/app/slicer/ (nur im Container nötig, nicht auf dem iPad).
//  - curaengine.wasm : CuraEngine 4.6.1 als WebAssembly (aus npm-Paket cura-wasm 1.5.2, dort als base64 im Lader eingebettet)
//  - curaengine.js   : Emscripten-Lader, umgebaut von ES-Modul zu normalem <script> (global "CuraEngine"), ohne eingebettete WASM
//                      → die WASM kommt wie bei OpenSCAD von Scriptable (base64 in Stücken) und wird per instantiateWasm übergeben
//  - viewer.js       : three.js + src/slicer-viewer.js (global "SlicerViewer")
//  - definitions/    : Cura-Druckerdefinitionen (aus npm-Paket cura-wasm-definitions 1.5.1)
//  - drucker.json    : Druckerbibliothek = Cura 4.6 + OrcaSlicer-Profile (tools/daten/orca-maschinen.json, 10p)
//  - ../../licenses/ : Lizenzen (CuraEngine AGPL-3.0, Definitionen LGPL-3.0, Lader MIT)
// Aufruf: npm run build:slicer
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import vm from 'vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scriptable/ScriptSCAD/app/slicer');
const licenses = path.join(root, 'scriptable/ScriptSCAD/licenses');
const cw = path.join(root, 'node_modules/cura-wasm');
const cwd = path.join(root, 'node_modules/cura-wasm-definitions');
fs.mkdirSync(out, { recursive: true });

// 1) Lader + WASM trennen
let js = fs.readFileSync(path.join(cw, 'src/CuraEngine.js'), 'utf8');
const m = js.match(/wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/);
if (!m) throw new Error('Eingebettete WASM nicht gefunden');
const wasm = Buffer.from(m[1], 'base64');
if (wasm.readUInt32BE(0) !== 0x0061736d) throw new Error('Keine WASM-Datei');
fs.writeFileSync(path.join(out, 'curaengine.wasm'), wasm);
js = js.replace(m[0], 'wasmBinaryFile="curaengine.wasm"');
if (!/export default CuraEngine;\s*$/.test(js)) throw new Error('export default CuraEngine nicht gefunden');
js = js.replace(/export default CuraEngine;\s*$/, 'window.CuraEngine = CuraEngine;\n');
js = '/* CuraEngine 4.6.1 WebAssembly (cura-wasm 1.5.2) – AGPL-3.0-or-later – siehe ../../licenses/ */\n' + js;
fs.writeFileSync(path.join(out, 'curaengine.js'), js);

// 2) Druckerdefinitionen: für 9a nur die Grundlagen (fdmprinter/fdmextruder); die Bibliothek folgt in 9c
const defDir = path.join(out, 'definitions');
fs.rmSync(defDir, { recursive: true, force: true });
fs.mkdirSync(defDir, { recursive: true });
for (const f of ['fdmprinter.def.json', 'fdmextruder.def.json']) fs.copyFileSync(path.join(cwd, 'src/definitions', f), path.join(defDir, f));

// 2b) Druckerbibliothek: Maschinenwerte jeder sichtbaren Cura-Definition aufgelöst (Vererbung) → app/slicer/drucker.json.
//     CuraEngine bekommt später immer die eigene Definition (erbt von fdmprinter) + diese Werte per -s → keine 380 Dateien nötig.
//     Nur G-Code-Dialekte, die ohne Cura-Oberfläche funktionieren (Marlin, RepRap, Repetier); UltiGCode/Griffin/Makerbot/BFB brauchen
//     einen von Cura erzeugten Kopf bzw. ein eigenes Dateiformat → ausgelassen.
{
  const D = path.join(cwd, 'src/definitions');
  const all = {};
  for (const f of fs.readdirSync(D)) if (f.endsWith('.def.json')) all[f.slice(0, -9)] = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  // Grundwerte aus dem Einstellungsbaum von fdmprinter/fdmextruder
  const base = {};
  const walk = (node) => { for (const [k, v] of Object.entries(node || {})) { if (v && v.default_value !== undefined) base[k] = v.default_value; if (v && v.children) walk(v.children); } };
  for (const cat of Object.values(all.fdmprinter.settings)) walk(cat.children);
  for (const cat of Object.values(all.fdmextruder.settings)) walk(cat.children);
  const literal = (v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return +t;
    if (t === 'True' || t === 'False') return t === 'True';
    const m = /^(['"])([\s\S]*)\1$/.exec(t);
    return m ? m[2] : undefined;
  };
  const chain = (id) => { const c = []; for (let j = all[id]; j; j = all[j.inherits]) c.unshift(j); return c; };
  const resolve = (id) => {
    const r = Object.assign({}, base);
    for (const j of chain(id)) for (const [k, o] of Object.entries(j.overrides || {})) {
      if (o.default_value !== undefined) r[k] = o.default_value; else { const l = literal(o.value); if (l !== undefined) r[k] = l; }
    }
    return r;
  };
  const meta = (id, key) => { for (let j = all[id]; j; j = all[j.inherits]) if (j.metadata && j.metadata[key] !== undefined) return j.metadata[key]; };
  const flavorOf = (f) => { f = String(f || '').trim(); if (/marlin/i.test(f)) return 'RepRap (Marlin/Sprinter)'; if (/^reprap( \(reprap\))?$/i.test(f)) return 'RepRap (RepRap)'; if (/repetier/i.test(f)) return 'Repetier'; return null; };
  const list = [];
  let skipped = 0;
  for (const id of Object.keys(all).sort()) {
    if (id.startsWith('fdm') || /_extruder|extruder_\d/.test(id) || meta(id, 'visible') === false || !all[id].name) continue;
    const r = resolve(id);
    const trains = meta(id, 'machine_extruder_trains');
    const ex = trains && trains['0'] && all[trains['0']] ? Object.assign({}, r, ...chain(trains['0']).map((j) => Object.fromEntries(Object.entries(j.overrides || {}).map(([k, o]) => [k, o.default_value !== undefined ? o.default_value : literal(o.value)]).filter(([, v]) => v !== undefined)))) : r;
    const flavor = flavorOf(r.machine_gcode_flavor);
    if (!flavor || !(r.machine_width > 0) || !(r.machine_depth > 0) || !(r.machine_height > 0)) { skipped++; continue; }
    list.push({ id, name: all[id].name, maker: String(meta(id, 'manufacturer') || 'Unbekannt').trim(), flavor,
      bedX: r.machine_width, bedY: r.machine_depth, bedZ: r.machine_height, centerZero: !!r.machine_center_is_zero, round: r.machine_shape === 'elliptic',
      heatedBed: r.machine_heated_bed !== false, nozzle: ex.machine_nozzle_size || 0.4, filamentDiameter: ex.material_diameter || r.material_diameter || 1.75,
      startGcode: String(r.machine_start_gcode || ''), endGcode: String(r.machine_end_gcode || ''),
      // Vorschläge für die Regler (Cura-Standardwerte der Definition)
      suggest: { retract: ex.retraction_amount, retractSpeed: ex.retraction_speed, speedPrint: r.speed_print, travelSpeed: r.speed_travel } });
  }
  // 10p: aktuelle Drucker aus OrcaSlicer (tools/daten/orca-maschinen.json, erzeugt von tools/fetch-orca-profiles.mjs) – u. a. Bambu Lab,
  // Anycubic Kobra, Creality K1/Ender-3 V3, Elegoo Neptune 4, Prusa MK4/Core One, Voron. Gleiches Modell wie in Cura → Orca gewinnt
  // (Cura-Kennung bleibt als „alias“, damit gespeicherte Einstellungen weiter passen).
  const orca = orcaPrinters();
  const key = (maker, name) => (maker + ' ' + name).toLowerCase().replace(/creality3d/g, 'creality').replace(/prusa3d|prusa research/g, 'prusa')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w, i, a) => w && a.indexOf(w) === i).sort().join(' ');
  const byKey = new Map(orca.list.map((p) => [key(p.maker, p.name), p]));
  let replaced = 0;
  const merged = [];
  for (const p of list) {
    const o = byKey.get(key(p.maker, p.name));
    if (o) { (o.alias = o.alias || []).push(p.id); replaced++; } else merged.push(p);
  }
  merged.push(...orca.list);
  merged.sort((a, b) => a.maker.localeCompare(b.maker) || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(out, 'drucker.json'), JSON.stringify({ quelle: 'Cura 4.6 Druckerdefinitionen (cura-wasm-definitions 1.5.1, LGPL-3.0) + ' + orca.quelle, drucker: merged }));
  console.log('Druckerbibliothek: ' + merged.length + ' Drucker (Cura ' + (list.length - replaced) + ', Orca ' + orca.list.length + ', davon ' + replaced +
    ' ersetzen Cura-Einträge), Cura ausgelassen ' + skipped + ', Orca ausgelassen ' + orca.skipped.length);
  fs.writeFileSync(path.join(root, 'tools/daten/orca-ausgelassen.txt'), orca.skipped.join('\n') + '\n');
}

// Orca-Druckerprofile → Einträge der Bibliothek (nur eine Düse je Modell: 0,4 mm; Düse lässt sich im Reiter Drucker ändern).
// Jeder Start-/End-/Schicht-Code wird mit SlicerCore.fillPlaceholders probeweise ausgewertet; bleibt etwas offen → Drucker ausgelassen.
function orcaPrinters() {
  const src = path.join(root, 'tools/daten/orca-maschinen.json');
  if (!fs.existsSync(src)) return { list: [], skipped: [], quelle: '' };
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  const box = { TextDecoder, Buffer };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, 'scriptable/ScriptSCAD/app/slicer-core.js'), 'utf8'), box);
  const Core = box.SlicerCore;
  const std = JSON.parse(fs.readFileSync(path.join(out, 'standard.json'), 'utf8'));
  const first = (v) => (Array.isArray(v) ? v[0] : typeof v === 'string' && v.includes(',') && !v.includes('\n') ? v.split(',')[0] : v);
  const area = (v) => (typeof v === 'string' ? v.split(',') : v || []).map((q) => String(q).split('x').map(Number));
  const MAKER = { Bambulab: 'Bambu Lab', 'Custom Printer': 'Allgemein (Orca)', 'Orca Arena Printer': 'Orca Arena', innovatiQ: 'innovatiQ' };
  const FLAVOR = { klipper: 'RepRap (Marlin/Sprinter)', marlin: 'RepRap (Marlin/Sprinter)', marlin2: 'RepRap (Marlin/Sprinter)', reprapfirmware: 'RepRap (RepRap)', repetier: 'Repetier' };
  const byModel = new Map();
  for (const m of data.maschinen) { const k = m.vendor + '|' + m.model; if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(m); }
  const list = [], skipped = [];
  for (const group of byModel.values()) {
    const m = group.find((x) => Number(first(x.nozzle_diameter)) === 0.4) || group[0];
    const why = (t) => skipped.push(m.vendor + ' · ' + m.model + ': ' + t);
    const flavor = m.gcode_flavor === undefined ? FLAVOR.marlin : FLAVOR[m.gcode_flavor];
    if (!flavor) { why('Dialekt ' + m.gcode_flavor); continue; }
    const a = area(m.printable_area);
    if (a.length < 3 || a.some((q) => q.length !== 2 || q.some((x) => !isFinite(x)))) { why('Bettform'); continue; }
    const xs = a.map((q) => q[0]), ys = a.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let centerZero = false, round = false;
    if (a.length > 8) { // rundes Bett (Delta)
      if (Math.abs(x0 + x1) > 1 || Math.abs(y0 + y1) > 1) { why('rundes Bett nicht mittig'); continue; }
      centerZero = true; round = true;
    } else if (Math.abs(x0 + x1) < 0.5 && Math.abs(y0 + y1) < 0.5 && x0 < 0) centerZero = true;
    else if (x0 < 0 || y0 < 0 || x0 > 10 || y0 > 10) { why('Bett verschoben (' + x0 + ',' + y0 + ')'); continue; }
    const name = m.model;
    const maker = MAKER[m.vendor] || m.vendor;
    const nozzle = Number(first(m.nozzle_diameter)) || 0.4;
    const dfp = String(first(m.default_filament_profile) || '');
    const p = {
      id: 'orca-' + (maker + '-' + name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, maker,
      note: 'OrcaSlicer-Profil', flavor,
      bedX: +(centerZero ? x1 - x0 : x1).toFixed(2), bedY: +(centerZero ? y1 - y0 : y1).toFixed(2), bedZ: Number(m.printable_height) || 250,
      centerZero, round, heatedBed: true, nozzle, filamentDiameter: /2\.85|3\.00?\b|2,85/.test(dfp) ? 2.85 : 1.75,
      startGcode: String(m.machine_start_gcode || ''), endGcode: String(m.machine_end_gcode || ''),
      suggest: { retract: Number(first(m.retraction_length)) || undefined, retractSpeed: Number(first(m.retraction_speed)) || undefined },
    };
    if (m.layer_change_gcode && String(m.layer_change_gcode).trim()) p.layerGcode = String(m.layer_change_gcode);
    if (m.before_layer_change_gcode && String(m.before_layer_change_gcode).trim()) p.beforeLayerGcode = String(m.before_layer_change_gcode);
    if (String(m.use_relative_e_distances) === '1') p.relativeE = true;
    if (m.vendor === 'Bambulab' && Array.isArray(m.nozzle_diameter) && m.nozzle_diameter.length > 1) { why('Bambu mit zwei Düsen (Düsenwahl nur in Bambu Studio)'); continue; }
    if (m.vendor === 'Bambulab') {
      // Bambu: Export als .gcode.3mf (Druck von der SD-Karte), Kennung des Modells für slice_info.config, Druckplatte des Herstellers
      p.bambu = { modelId: m.model_id || '' };
      p.bedType = m.default_bed_type || 'Textured PEI Plate';
      p.relativeE = true;
      p.note = 'Bambu Lab · Export als .gcode.3mf (SD-Karte)';
      p.suggest = Object.assign(p.suggest, { speedPrint: 150, speedOuterWall: 100, speedInfill: 200, speedFirstLayer: 40, travelSpeed: 400 });
      if (!p.bambu.modelId) { why('Bambu ohne model_id'); continue; }
    }
    for (const k of Object.keys(p.suggest)) if (p.suggest[k] === undefined) delete p.suggest[k];
    // Probe: alle Makros auswertbar?
    const probe = Object.assign({}, p, std.values, std.materials.PLA, { material: 'PLA', bounds: { min: [80, 80, 0], max: [120, 120, 20] } });
    const miss = [];
    for (const c of [p.startGcode, p.endGcode, p.layerGcode, p.beforeLayerGcode]) {
      if (!c) continue;
      const r = Core.fillPlaceholders(c, probe, { layer_num: 3, layer_z: 0.8, total_layer_count: 100 });
      miss.push(...r.missing);
      for (const line of r.code.split('\n')) { const cm = line.split(';')[0].match(/\{[a-z0-9_]+[^}]*\}|\[[a-z0-9_]+\]/g); if (cm) miss.push(...cm); }
    }
    if (miss.length) { why('offen: ' + Array.from(new Set(miss)).slice(0, 6).join(', ')); continue; }
    list.push(p);
  }
  return { list, skipped, quelle: data.quelle };
}

// 3) 3D-Ansicht (three.js) bündeln → global SlicerViewer
await esbuild.build({ entryPoints: [path.join(root, 'src/slicer-viewer.js')], bundle: true, format: 'iife', minify: true, target: ['safari16'],
  outfile: path.join(out, 'viewer.js'), legalComments: 'eof' });

// 4) Lizenzen
fs.mkdirSync(licenses, { recursive: true });
fs.copyFileSync(path.join(cw, 'LICENSE'), path.join(licenses, 'CuraEngine-cura-wasm-AGPL-3.0.txt'));
fs.copyFileSync(path.join(cwd, 'LICENSE'), path.join(licenses, 'Cura-Definitionen-LGPL-3.0.txt'));

console.log('Slicer gebaut: curaengine.js ' + Math.round(js.length / 1024) + ' KB, curaengine.wasm ' + Math.round(wasm.length / 1024) + ' KB');
