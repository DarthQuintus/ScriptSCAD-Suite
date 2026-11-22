# Source of the bundled files

Most of ScriptSCAD is plain, readable JavaScript in [`Scriptable/ScriptSCAD/app`](../Scriptable/ScriptSCAD/app).
A few files there are generated (bundled or extracted from npm packages). This folder contains everything needed to rebuild them:

| Generated file | Built from | Script |
|---|---|---|
| `app/lib/openscad.wasm`, `app/lib/openscad.js` | npm `openscad-playground@2.4.0` (official OpenSCAD 2025.03.25 WebAssembly build); loader turned from an ES module into a classic script | `tools/build.mjs` |
| `app/lib/viewer.js` | three.js r170 + [`src/viewer.js`](src/viewer.js), bundled with esbuild | `tools/build.mjs` |
| `app/lib/editor.js` | CodeMirror 6 + [`src/editor.js`](src/editor.js), bundled with esbuild | `tools/build.mjs` |
| `app/lib/scad-hints.js` | function list read from `app/bibliothek/scriptscad.scad` and the bundled OpenSCAD libraries | `tools/build.mjs` |
| `../fonts/`, `../bibliotheken/*.json` | fonts and libraries from `openscad-playground@2.4.0` (BOSL2, MCAD) and NopSCADlib, unmodified | `tools/build.mjs` |
| `app/slicer/curaengine.wasm`, `app/slicer/curaengine.js` | npm `cura-wasm@1.5.2` (CuraEngine 4.6.1); the embedded wasm is extracted unchanged | `tools/build-slicer.mjs` |
| `app/slicer/viewer.js` | three.js r170 + [`src/slicer-viewer.js`](src/slicer-viewer.js) | `tools/build-slicer.mjs` |
| `app/slicer/definitions/` | npm `cura-wasm-definitions@1.5.1` (Ultimaker Cura printer definitions), unmodified | `tools/build-slicer.mjs` |
| `app/slicer/drucker.json` | Cura printer definitions (above) + OrcaSlicer printer profiles (`resources/profiles`, AGPL-3.0), fetched into `tools/daten/orca-maschinen.json` | `tools/fetch-orca-profiles.mjs`, `tools/build-slicer.mjs` |

Rebuild (Node.js 20+). The scripts expect the original project layout, so copy them into place first:

```sh
mkdir work && cd work
cp -r ../source/src ../source/tools ../source/package.json ../source/package-lock.json .
mkdir -p scriptable && cp -r ../Scriptable/ScriptSCAD scriptable/
npm ci
npm run build          # OpenSCAD, editor, viewer, fonts, libraries
npm run build:slicer   # CuraEngine, slicer viewer, printer definitions
```

Upstream sources: OpenSCAD <https://github.com/openscad/openscad> (commit ce5039f8a), openscad-playground <https://github.com/openscad/openscad-playground>,
CuraEngine <https://github.com/Ultimaker/CuraEngine> (4.6.1), cura-wasm <https://github.com/Cloud-CNC/cura-wasm> (changes to CuraEngine: `docker/CuraEngine.patch`),
Cura <https://github.com/Ultimaker/Cura>, OrcaSlicer <https://github.com/SoftFever/OrcaSlicer>, three.js <https://github.com/mrdoob/three.js>, CodeMirror <https://codemirror.net>.
All licenses: [`Scriptable/ScriptSCAD/licenses`](../Scriptable/ScriptSCAD/licenses).
