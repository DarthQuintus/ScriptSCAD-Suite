// Baut die Slicer-Bibliotheken für scriptable/ScriptSCAD/app/slicer/ (nur im Container nötig, nicht auf dem iPad).
//  - curaengine.wasm : CuraEngine 4.6.1 als WebAssembly (aus npm-Paket cura-wasm 1.5.2, dort als base64 im Lader eingebettet)
//  - curaengine.js   : Emscripten-Lader, umgebaut von ES-Modul zu normalem <script> (global "CuraEngine"), ohne eingebettete WASM
//                      → die WASM kommt wie bei OpenSCAD von Scriptable (base64 in Stücken) und wird per instantiateWasm übergeben
//  - viewer.js       : three.js + src/slicer-viewer.js (global "SlicerViewer")
//  - definitions/    : Cura-Druckerdefinitionen (aus npm-Paket cura-wasm-definitions 1.5.1)
//  - ../../licenses/ : Lizenzen (CuraEngine AGPL-3.0, Definitionen LGPL-3.0, Lader MIT)
// Aufruf: npm run build:slicer
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

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
  list.sort((a, b) => a.maker.localeCompare(b.maker) || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(out, 'drucker.json'), JSON.stringify({ quelle: 'Cura 4.6 Druckerdefinitionen (cura-wasm-definitions 1.5.1, LGPL-3.0)', drucker: list }));
  console.log('Druckerbibliothek: ' + list.length + ' Drucker, ' + skipped + ' ausgelassen (Dialekt/Maße)');
}

// 3) 3D-Ansicht (three.js) bündeln → global SlicerViewer
await esbuild.build({ entryPoints: [path.join(root, 'src/slicer-viewer.js')], bundle: true, format: 'iife', minify: true, target: ['safari16'],
  outfile: path.join(out, 'viewer.js'), legalComments: 'eof' });

// 4) Lizenzen
fs.mkdirSync(licenses, { recursive: true });
fs.copyFileSync(path.join(cw, 'LICENSE'), path.join(licenses, 'CuraEngine-cura-wasm-AGPL-3.0.txt'));
fs.copyFileSync(path.join(cwd, 'LICENSE'), path.join(licenses, 'Cura-Definitionen-LGPL-3.0.txt'));

console.log('Slicer gebaut: curaengine.js ' + Math.round(js.length / 1024) + ' KB, curaengine.wasm ' + Math.round(wasm.length / 1024) + ' KB');
