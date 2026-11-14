# Technical details

This page explains how ScriptSCAD works internally. For installation, see the [README](../README.md).

## Architecture

ScriptSCAD is not an App Store app. It runs inside **Scriptable**, which offers JavaScript, file access to iCloud Drive and a `WebView`.
Each tool consists of two halves that talk to each other:

```
┌─ Scriptable (JavaScript, native APIs) ──────────┐        ┌─ WebView (HTML user interface) ───────────────┐
│ app/main.js  (Studio) / app/slicer-main.js       │  ───▶  │ index.html + app.js        (Studio)           │
│ files, iCloud, share sheet, photos, keychain,    │ evaluate│ slicer.html + slicer.js    (Slicer)           │
│ shortcuts, network requests, log                 │ JS      │ editor, 3D view, sliders                      │
│                                                  │  ◀───  │ OpenSCAD.wasm / CuraEngine.wasm               │
└──────────────────────────────────────────────────┘ polling └───────────────────────────────────────────────┘
                         │
                         ▼
        iCloud Drive / Scriptable / ScriptSCAD /  (projects, settings, AI exchange files)
```

- **Starter scripts.** `ScriptSCAD Studio.js` and `ScriptSCAD Slicer.js` are tiny and never change. Scriptable caches scripts, so the starter reads `ScriptSCAD/app/main.js` (or `slicer-main.js`) as text and runs it with an `AsyncFunction`. An update therefore only replaces the folder `ScriptSCAD/app`.
- **Scriptable ↔ page.** Scriptable calls `webView.evaluateJavaScript(…, true)` and receives results only through `completion(text)` – never a Promise or object. The page queues its actions (render, save, export, AI …) and Scriptable fetches them by **polling** (`App.poll`). Timeouts use Scriptable's `Timer`.
- **WebAssembly without a server.** Pages are loaded with `WebView.loadFile`, but `fetch()` on `file://` is unreliable in WKWebView. Scriptable therefore reads the `.wasm` file, sends it to the page as base64 in 256 KB chunks, and the page compiles it once (`WebAssembly.compile`). Each render or slice creates a fresh Emscripten instance from the compiled module (`instantiateWasm`), because `callMain` can only run once per instance.
- **Offline.** All libraries, fonts and engines are local files. Only the AI request and the optional update check use the network.
- **Text.** All user-visible texts are in `app/i18n.js` (Studio), `app/slicer-i18n.js` (Slicer) and `app/about.js` (About & licenses), each in German and English.
- **Log.** Both tools write a rolling log (`ScriptSCAD/log.txt` and `ScriptSCAD/slicer-log.txt`), viewable in the app – the main diagnostic tool on a device without developer tools.

## Files in iCloud Drive

```
iCloud Drive/Scriptable/
├─ ScriptSCAD Studio.js          starter
├─ ScriptSCAD Slicer.js          starter
└─ ScriptSCAD/
   ├─ app/                       program (replaced by updates)
   │  ├─ main.js, index.html, app.js, …      Studio
   │  ├─ slicer-main.js, slicer.html, …      Slicer
   │  ├─ ui-common.js, vctl.js, projekte.js, about.js, style.css   shared
   │  ├─ lib/       openscad.wasm/.js, editor.js (CodeMirror), viewer.js (three.js), scad-hints.js
   │  ├─ slicer/    curaengine.wasm/.js, viewer.js, drucker.json, standard.json, definitions/
   │  ├─ bibliothek/scriptscad.scad          built-in library (threads, nuts, chamfers …)
   │  └─ update-quelle.json                  where to look for updates
   ├─ bibliotheken/             BOSL2, MCAD, NopSCADlib (one JSON package each)
   ├─ fonts/                    fonts for text()
   ├─ licenses/                 all license texts + README.txt
   │                            ── created on first start: ──
   ├─ projects/<name>/          model.scad, project.json, history/, export/, teile/ (imported parts)
   ├─ slicer/                   slicer settings, own printers, profiles, plates, G-code of the test cube
   ├─ ai/                       exchange files with the shortcut
   ├─ papierkorb/               deleted projects (restorable)
   ├─ updates/                  downloaded update ZIPs
   ├─ settings.json             language, theme, editor settings (shared by both tools)
   └─ log.txt, slicer-log.txt
```

Before reading, every file is fetched with `downloadFileFromiCloud()`, because iOS may have offloaded it.

## ScriptSCAD Studio

### Rendering
The page writes `model.scad` (plus the library files that the model `include`s or `use`s, imported parts and fonts) into the Emscripten file system and runs OpenSCAD 2025.03.25 with the **Manifold** backend. Output is binary STL for the 3D view, or OFF when colors are needed (`color()` → per-face colors in the view and in 3MF export). The 3MF writer and the "one STL per body" split (union-find over shared vertices; cavities stay with the enclosing body) are in `app/export.js`.

### Sliders and object editor
`app/params.js` reads the variables at the top of the file, including OpenSCAD Customizer comments such as `// [20:150]` and `/* [Group] */`. Changing a slider rewrites only that number in the code and re-renders (throttled while dragging).
`app/objects.js` parses the object tree (`translate`, `rotate`, `cube`, `cylinder`, module calls …) and edits position, rotation, size, chamfers and fillets directly in the code. Tapping the 3D view selects an object by a ray cast on per-object meshes.

### AI
```
Studio ──▶ ai/prompt.txt, ai/request.json (+ ai/view.jpg, ai/upload-*)
       ──▶ shortcuts://x-callback-url/run-shortcut?name=ScriptSCAD%20KI&input=<agent>
                   │  Shortcut "ScriptSCAD KI": reads the prompt, asks the chosen AI,
                   │  writes the answer to ai/response.txt, returns "SCRIPTSCAD-FERTIG"
Studio ◀── x-callback ── reads ai/response.txt → extracts the ```openscad block → preview → apply
```
- Studio builds the whole prompt itself: rules (millimetres, return the complete file in one `openscad` code block, keep parameters and structure), the built-in library reference, the current code, imported parts with their dimensions, and on request the last error messages (*repair*).
- The answer is shown as a preview next to the current model; nothing changes until you tap *Apply*. The previous version goes to `history/`.
- The Claude app action does not return long answers to Shortcuts, so for Claude the answer is copied and Studio reads it from the clipboard.
- The shortcut source is [`shortcut/ScriptSCAD KI.cherri`](../shortcut/ScriptSCAD%20KI.cherri), written in [Cherri](https://cherrilang.org). Apple Intelligence uses the built-in *Use Model* action; the ChatGPT and Claude app actions are called by their action identifiers. Build and sign:

  ```sh
  cherri "ScriptSCAD KI.cherri" --share=anyone --signing-server=https://hubsign.routinehub.services/sign
  ```

### Updates
`app/update-quelle.json` points to [`version.json`](../version.json) in this repository (`{ version, zip, notes }`). Studio only checks when you tap the button, downloads the update ZIP only after you confirm, and never installs anything by itself.

## ScriptSCAD Slicer

```
STL / OBJ / 3MF ──▶ parse + repair ──▶ place on the plate ──▶ merge to one STL
                                                                    │
            settings + printer definition ──▶ CuraEngine arguments  ▼
                                               CuraEngine.wasm (Web Worker) ──▶ G-code
                                                                    │
                                    preview (3D / layer / G-code, time slider) ◀┘
```

- **Engine:** CuraEngine 4.6.1 compiled to WebAssembly by the cura-wasm project. Slicing runs in a **Web Worker**, so the page stays responsive and slicing can be cancelled; if a device cannot start the worker, the page slices on the main thread instead.
- **Printers:** `app/slicer/drucker.json` is a condensed list of about 300 printers from the Cura definitions (build volume, origin, G-code flavor, start/end code, nozzle). The full Cura definition files in `app/slicer/definitions/` are passed to CuraEngine. Own printers and parameter profiles are stored in `ScriptSCAD/slicer/` and can be exported as one JSON file.
- **Settings import** reads the settings block that other slicers write into G-code (Cura `;SETTING_3`, PrusaSlicer `; prusaslicer_config`, Bambu/Orca `; CONFIG_BLOCK_START`, Simplify3D header comments) and maps it to ScriptSCAD's settings.
- **Mesh import and repair** (`app/slicer-core.js`): STL (binary/ASCII), OBJ, 3MF (ZIP via `DecompressionStream`, units, components, transforms). Repair welds vertices, removes degenerate and duplicate triangles, orients faces per shell and closes small holes.
- **Preview:** the G-code is parsed into moves per layer with feature types (outer wall, inner wall, top/bottom, infill, skirt, support) and drawn with three.js; the time slider replays the print using the planned feed rates.
- **Network printers:** OctoPrint (`/api/files/local`), Moonraker (`/server/files/upload`) and PrusaLink (`PUT /api/v1/files/usb/…`) via Scriptable's `Request`. API keys are stored in the iOS **keychain**, not in iCloud files.

## Licenses and source code

| Part | License |
|---|---|
| ScriptSCAD Studio, ScriptSCAD Slicer, shortcut (all files not listed below) | **GPL-3.0-or-later**, © 2026 Anton Angierski – [LICENSE](../LICENSE) |
| `app/lib/openscad.wasm`, `openscad.js` – OpenSCAD 2025.03.25 (git `ce5039f8a`) | GPL-2.0-or-later; the binary also contains CGAL (GPL-3.0-or-later), Manifold (Apache-2.0), Boost, Eigen, Clipper, FreeType, HarfBuzz, Fontconfig and others, so the binary as a whole is distributed under GPL-3.0 |
| `app/slicer/curaengine.wasm`, `curaengine.js` – CuraEngine 4.6.1 via cura-wasm 1.5.2 | AGPL-3.0-or-later (CuraEngine), MIT (cura-wasm loader) |
| `app/slicer/definitions/`, `drucker.json` – Cura printer definitions via cura-wasm-definitions 1.5.1 | LGPL-3.0-or-later |
| `app/lib/viewer.js`, `app/slicer/viewer.js` – contain three.js r170 | MIT (+ GPL-3.0-or-later for the ScriptSCAD part) |
| `app/lib/editor.js` – contains CodeMirror 6 / Lezer | MIT (+ GPL-3.0-or-later for the ScriptSCAD part) |
| `bibliotheken/BOSL2.json`, `MCAD.json`, `NopSCADlib.json` | BSD-2-Clause, LGPL-2.1, GPL-3.0 |
| `fonts/`, `app/fonts/` – Liberation, Noto Sans, Space Grotesk, JetBrains Mono | SIL OFL 1.1 |

All license texts and exact versions are in [`Scriptable/ScriptSCAD/licenses`](../Scriptable/ScriptSCAD/licenses) (`README.txt` lists every file). Both tools show the list under **Settings › About & licenses**, as the GPL asks for interactive programs.

**Corresponding source.** All ScriptSCAD code is shipped as readable source in `Scriptable/ScriptSCAD/app`. The generated files (WebAssembly engines extracted from npm packages, minified bundles) can be rebuilt with the scripts and sources in [`source/`](../source) – see its README. The upstream sources are:

- OpenSCAD: <https://github.com/openscad/openscad>, commit `ce5039f8a` (with its submodules), built by <https://github.com/openscad/openscad-playground> (npm `openscad-playground@2.4.0`)
- CuraEngine: <https://github.com/Ultimaker/CuraEngine>, version 4.6.1, with the patch `docker/CuraEngine.patch` from <https://github.com/Cloud-CNC/cura-wasm> (npm `cura-wasm@1.5.2`)
- Cura definitions: <https://github.com/Ultimaker/Cura>, <https://github.com/Cloud-CNC/cura-wasm-definitions> (npm `cura-wasm-definitions@1.5.1`)
- three.js r170, CodeMirror 6, BOSL2, MCAD, NopSCADlib (commit `00ec2898c0a2`): see `licenses/README.txt`

If any of these upstream sources become unavailable, open an issue and you will get a copy of the exact source used.

## Releases

A tag `v<version>` (for example `v10o.2`) – or running it by hand under *Actions › Release › Run workflow*, which creates the tag from `version.json` – starts the GitHub Action [`.github/workflows/release.yml`](../.github/workflows/release.yml). It builds two files and attaches them to a GitHub release:

| File | Content | For |
|---|---|---|
| `ScriptSCAD-<version>.zip` | `ScriptSCAD Studio.js`, `ScriptSCAD Slicer.js`, folder `ScriptSCAD/` (app, bibliotheken, fonts, licenses), `ScriptSCAD KI.shortcut`, `LICENSE` | first installation |
| `ScriptSCAD-<version>-update.zip` | folder `app/` only | updates (linked in `version.json`) |

Version numbers follow the development steps (`10o.1` = step 10, part o, delivery 1) and are compared step by step, so `9i.2 < 10m.1 < 10o.1`.

## Development

This repository contains only what you need to use ScriptSCAD, plus the sources required by the licenses. Development (plans, container tests with Node.js/Playwright against a simulated Scriptable, design drafts) happens in a separate repository. Bug reports and ideas are welcome as [issues](../../../issues).
