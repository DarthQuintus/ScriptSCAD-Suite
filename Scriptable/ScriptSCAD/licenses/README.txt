Lizenzen / Licenses – ScriptSCAD Studio + ScriptSCAD Slicer
==========================================================

ScriptSCAD Studio, ScriptSCAD Slicer und der Kurzbefehl „ScriptSCAD KI“
  (ScriptSCAD Studio.js, ScriptSCAD Slicer.js, app/*.js, app/*.html, app/style.css, app/bibliothek/scriptscad.scad)
  © 2026 Anton Angierski – GPL-3.0-or-later (ScriptSCAD-GPL-3.0.txt). OHNE JEDE GEWÄHRLEISTUNG / NO WARRANTY.
  Quellcode, Bauanleitung und Updates: https://github.com/DarthQuintus/ScriptSCAD-Suite
  (Ordner source/ dort: Quellen und Bauskripte für app/lib/*.js und app/slicer/*.js).

Mitgelieferte Bestandteile Dritter / Third-party components
-----------------------------------------------------------

app/lib/openscad.wasm, app/lib/openscad.js
  OpenSCAD 2025.03.25 (git ce5039f8a), WebAssembly-Build, Lizenz GPL-2.0-or-later (OpenSCAD-GPL-2.0.txt).
  Der Build enthält weitere freie Bibliotheken, u. a. CGAL (GPL-3.0-or-later, daher gilt für das Binary
  insgesamt GPL-3.0), Manifold (Apache-2.0), Boost (BSL-1.0), Eigen (MPL-2.0), Clipper (BSL-1.0),
  FreeType (FTL/GPL-2.0), HarfBuzz (MIT), Fontconfig (MIT) – Quellen über das OpenSCAD-Repository (Submodule).
  Quellcode: https://github.com/openscad/openscad (Commit ce5039f8a)
             https://github.com/openscad/openscad-playground
  Bezogen über das npm-Paket openscad-playground@2.4.0; openscad.js wurde nur minimal
  angepasst (ES-Modul -> normales Skript, siehe tools/build.mjs im Projekt-Repository).

app/lib/viewer.js
  enthält three.js r170 (MIT-Lizenz, three.js-MIT.txt), https://github.com/mrdoob/three.js

app/lib/editor.js
  enthält CodeMirror 6 (MIT-Lizenz, CodeMirror-MIT.txt), https://codemirror.net

fonts/ (Schriftarten für text())
  Liberation Sans, Liberation Serif, Liberation Mono (Red Hat / Google) und Noto Sans (Google),
  Lizenz SIL Open Font License 1.1 (Fonts-OFL-1.1.txt). Bezogen aus fonts.zip im npm-Paket
  openscad-playground@2.4.0 (Auswahl lateinischer Schriften, unverändert).

app/fonts/SpaceGrotesk-*.woff2, app/fonts/JetBrainsMono-*.woff2
  Schriften Space Grotesk und JetBrains Mono (Ausschnitt „latin“), SIL Open Font License 1.1
  (Schriften-OFL-1.1.txt, Kopie in app/fonts/OFL.txt). Bezogen über die npm-Pakete
  @fontsource/space-grotesk und @fontsource/jetbrains-mono 5.x.
  https://github.com/floriankarsten/space-grotesk  https://github.com/JetBrains/JetBrainsMono

bibliotheken/ (OpenSCAD-Bibliotheken, je eine Paketdatei <Name>.json mit den unveränderten .scad-Dateien)
  BOSL2.json       BOSL2 (Belfry OpenSCAD Library v2, Fassung 2.0.716), BSD-2-Clause (BOSL2-BSD-2-Clause.txt).
                   https://github.com/BelfrySCAD/BOSL2 – bezogen aus BOSL2.zip im npm-Paket openscad-playground@2.4.0.
  MCAD.json        MCAD (OpenSCAD Parametric CAD Library), LGPL-2.1 (MCAD-LGPL-2.1.txt).
                   https://github.com/openscad/MCAD – bezogen aus MCAD.zip im npm-Paket openscad-playground@2.4.0.
  NopSCADlib.json  NopSCADlib von Chris Palmer (nophead), GPL-3.0 (NopSCADlib-GPL-3.0.txt).
                   https://github.com/nophead/NopSCADlib (Commit 00ec2898c0a2, September 2026).
  Ohne Test-, Beispiel- und Doku-Dateien. Die Bibliotheken werden nur gelesen, wenn ein Modell sie einbindet.

app/slicer/curaengine.wasm, app/slicer/curaengine.js   (nur ScriptSCAD Slicer)
  CuraEngine 4.6.1 (Ultimaker), WebAssembly-Build aus dem npm-Paket cura-wasm 1.5.2 (Cloud CNC),
  Lizenz AGPL-3.0-or-later; der JavaScript-Lader von cura-wasm steht unter MIT
  (beides in CuraEngine-cura-wasm-AGPL-3.0.txt). Die wasm wurde unverändert aus dem Lader herausgelöst,
  der Lader minimal angepasst (ES-Modul -> normales Skript, siehe source/tools/build-slicer.mjs).
  Quellcode: https://github.com/Ultimaker/CuraEngine (Version 4.6.1)
             https://github.com/Cloud-CNC/cura-wasm (Version 1.5.2, Änderungen an CuraEngine: docker/CuraEngine.patch)

app/slicer/definitions/   (nur ScriptSCAD Slicer)
  Druckerdefinitionen aus Ultimaker Cura, über das npm-Paket cura-wasm-definitions 1.5.1, unverändert,
  Lizenz LGPL-3.0-or-later (Cura-Definitionen-LGPL-3.0.txt; Paket-Code MIT, © Cloud CNC).
  Quellcode: https://github.com/Ultimaker/Cura  https://github.com/Cloud-CNC/cura-wasm-definitions

app/slicer/viewer.js   (nur ScriptSCAD Slicer)
  enthält three.js r170 (MIT-Lizenz, three.js-MIT.txt) und die eigene Datei source/src/slicer-viewer.js.
