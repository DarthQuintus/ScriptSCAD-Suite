// Baut die Bibliotheken für scriptable/ScriptSCAD/app/lib/ (nur im Container nötig, nicht auf dem iPad).
//  - openscad.wasm  : offizieller OpenSCAD-WebAssembly-Build (aus npm-Paket openscad-playground)
//  - openscad.js    : Emscripten-Lader, umgebaut von ES-Modul zu normalem <script> (global "OpenSCAD")
//  - viewer.js      : three.js + OrbitControls + STLLoader + src/viewer.js als ein Skript (global "SCADViewer")
//  - editor.js      : CodeMirror 6 + OpenSCAD-Hervorhebung (src/editor.js, global "SCADEditor")
//  - ../../fonts/   : Schriftarten für text() (Liberation Sans/Serif/Mono, Noto Sans)
// Aufruf: npm run build
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'scriptable/ScriptSCAD/app/lib');
const licenses = path.join(root, 'scriptable/ScriptSCAD/licenses');
const pg = path.join(root, 'node_modules/openscad-playground/dist/wasm');
fs.mkdirSync(lib, { recursive: true });
fs.mkdirSync(licenses, { recursive: true });

// 1) WASM kopieren
fs.copyFileSync(path.join(pg, 'openscad.wasm'), path.join(lib, 'openscad.wasm'));

// 2) openscad.js: ES-Modul -> klassisches Skript
let js = fs.readFileSync(path.join(pg, 'openscad.js'), 'utf8');
const metaCount = (js.match(/import\.meta\.url/g) || []).length;
if (metaCount !== 2) throw new Error('Unerwartete Anzahl import.meta.url: ' + metaCount);
js = js.replace(/import\.meta\.url/g, '__scadScriptUrl');
if (!/export default OpenSCAD;\s*$/.test(js)) throw new Error('export default OpenSCAD nicht gefunden');
js = js.replace(/export default OpenSCAD;\s*$/, 'window.OpenSCAD = OpenSCAD;\n');
js =
  '/* OpenSCAD 2025.03.25 WebAssembly – GPL-2.0-or-later – siehe ../../licenses/ */\n' +
  'var __scadScriptUrl = (document.currentScript && document.currentScript.src) || location.href;\n' +
  js;
fs.writeFileSync(path.join(lib, 'openscad.js'), js);

// 3) Viewer (three.js) und Editor (CodeMirror 6) bündeln
for (const name of ['viewer', 'editor']) {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/' + name + '.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: ['safari16'],
    outfile: path.join(lib, name + '.js'),
    legalComments: 'eof',
  });
}

// 4) Lizenzen
fs.copyFileSync(path.join(root, 'node_modules/three/LICENSE'), path.join(licenses, 'three.js-MIT.txt'));
fs.copyFileSync(path.join(root, 'node_modules/@codemirror/view/LICENSE'), path.join(licenses, 'CodeMirror-MIT.txt'));

// 5) Schriftarten für text() (7f): lateinische Auswahl aus fonts.zip von openscad-playground → ScriptSCAD/fonts/
//    (eigener Ordner neben app/, damit App-Updates klein bleiben). Standardschrift von OpenSCAD ist „Liberation Sans“.
const fontsDir = path.join(root, 'scriptable/ScriptSCAD/fonts');
const FONT_RE = /^(Liberation(Sans|Serif|Mono)-.*|NotoSans-(Regular|Bold|Italic))\.ttf$/;
fs.rmSync(fontsDir, { recursive: true, force: true });
fs.mkdirSync(fontsDir, { recursive: true });
const zip = path.join(root, 'node_modules/openscad-playground/dist/libraries/fonts.zip');
const tmp = fs.mkdtempSync(path.join(root, 'node_modules/.fonts-'));
execFileSync('unzip', ['-q', '-o', zip, '-d', tmp]);
for (const f of fs.readdirSync(tmp).filter((n) => FONT_RE.test(n)).sort()) fs.copyFileSync(path.join(tmp, f), path.join(fontsDir, f));
fs.copyFileSync(path.join(tmp, 'LICENSE'), path.join(licenses, 'Fonts-OFL-1.1.txt'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('fonts/', fs.readdirSync(fontsDir).length, 'Dateien');

// 6) Fremdbibliotheken (7g): BOSL2 + MCAD aus openscad-playground, NopSCADlib von GitHub (feste Fassung; das Playground-ZIP
//    enthält die Kerndateien core.scad/lib.scad nicht). Je Bibliothek EINE Paketdatei ScriptSCAD/bibliotheken/<Name>.json
//    ({ "<Name>/pfad.scad": Inhalt }) → Scriptable überträgt wenige große Stücke statt Hunderter Einzeldateien.
//    Nur .scad, ohne tests/examples/docs. Eigener Ordner neben app/ (App-Updates bleiben klein).
const NOP_COMMIT = '00ec2898c0a2cdebd446f0175671b633d5ae7d5f'; // NopSCADlib v21.43.1+ (2026-09-24)
const libsDir = path.join(root, 'scriptable/ScriptSCAD/bibliotheken');
const SKIP_DIRS = new Set(['tests', 'examples', 'docs', 'gallery', 'scripts', 'images', '.git', '.github']);
function packDir(src, prefix, out) {
  for (const n of fs.readdirSync(src).sort()) {
    if (SKIP_DIRS.has(n)) continue;
    const p = path.join(src, n);
    if (fs.statSync(p).isDirectory()) packDir(p, prefix + '/' + n, out);
    else if (n.endsWith('.scad')) out[prefix + '/' + n] = fs.readFileSync(p, 'utf8');
  }
  return out;
}
function unzipTo(name) {
  const dir = fs.mkdtempSync(path.join(root, 'node_modules/.lib-'));
  execFileSync('unzip', ['-q', '-o', path.join(root, 'node_modules/openscad-playground/dist/libraries', name + '.zip'), '-d', dir]);
  return dir;
}
fs.rmSync(libsDir, { recursive: true, force: true });
fs.mkdirSync(libsDir, { recursive: true });
const nopDir = path.join(root, 'node_modules/.cache/NopSCADlib-' + NOP_COMMIT.slice(0, 8));
if (!fs.existsSync(path.join(nopDir, 'core.scad'))) {
  fs.rmSync(nopDir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', 'https://github.com/nophead/NopSCADlib.git', nopDir]);
  execFileSync('git', ['-C', nopDir, 'checkout', '-q', NOP_COMMIT]);
}
const libSources = [
  ['BOSL2', unzipTo('BOSL2'), 'LICENSE', 'BOSL2-BSD-2-Clause.txt'],
  ['MCAD', unzipTo('MCAD'), null, 'MCAD-LGPL-2.1.txt'],
  ['NopSCADlib', nopDir, 'COPYING', 'NopSCADlib-GPL-3.0.txt'],
];
for (const [name, dir, licFile, licOut] of libSources) {
  const pack = packDir(dir, name, {});
  fs.writeFileSync(path.join(libsDir, name + '.json'), JSON.stringify(pack));
  if (licFile) fs.copyFileSync(path.join(dir, licFile), path.join(licenses, licOut));
  else if (fs.existsSync('/usr/share/common-licenses/LGPL-2.1')) fs.copyFileSync('/usr/share/common-licenses/LGPL-2.1', path.join(licenses, licOut));
  if (!fs.existsSync(path.join(licenses, licOut))) throw new Error('Lizenz fehlt: ' + licOut);
  if (dir.includes('.lib-')) fs.rmSync(dir, { recursive: true, force: true });
  console.log(('bibliotheken/' + name).padEnd(24), String(Object.keys(pack).length).padStart(4), 'Dateien', (fs.statSync(path.join(libsDir, name + '.json')).size / 1024).toFixed(0).padStart(6), 'KB');
}

// 7) Autovervollständigung (10h): Module/Funktionen aus scriptscad.scad und den Fremdbibliotheken → app/lib/scad-hints.js (global SCAD_HINTS)
//    Je Eintrag: Name, Art (module/function), Parameter, Datei (für include/use). Namen mit „_“ am Anfang (intern) entfallen.
function scanScad(text, file, out) {
  const re = /^[ \t]*(module|function)[ \t]+([A-Za-z][A-Za-z0-9_]*)[ \t]*\(/gm;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) { const c = text[i]; if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--; i++; }
    let params = text.slice(re.lastIndex, i - 1).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    if (params.length > 160) params = params.slice(0, 157) + '…';
    if (!out.some((e) => e.n === m[2] && e.f === file)) out.push({ n: m[2], k: m[1] === 'module' ? 'm' : 'f', p: params, f: file });
  }
}
const hints = [];
scanScad(fs.readFileSync(path.join(root, 'scriptable/ScriptSCAD/app/bibliothek/scriptscad.scad'), 'utf8'), 'scriptscad.scad', hints);
for (const name of ['BOSL2', 'MCAD', 'NopSCADlib']) {
  const pack = JSON.parse(fs.readFileSync(path.join(libsDir, name + '.json'), 'utf8'));
  for (const [file, text] of Object.entries(pack)) if (/\.scad$/.test(file) && !/\/(tests?|examples?|scripts)\//.test(file)) scanScad(text, file, hints);
}
fs.writeFileSync(path.join(lib, 'scad-hints.js'), '/* Autovervollständigung (10h), erzeugt von tools/build.mjs – nicht von Hand ändern */\nwindow.SCAD_HINTS = ' + JSON.stringify(hints) + ';\n');
console.log('Autovervollständigung:', hints.length, 'Module/Funktionen');

for (const f of fs.readdirSync(lib)) {
  console.log(f.padEnd(16), (fs.statSync(path.join(lib, f)).size / 1024).toFixed(0).padStart(6), 'KB');
}
