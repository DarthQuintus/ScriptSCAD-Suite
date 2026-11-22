// ScriptSCAD – „Über & Lizenzen“ für Studio (app.js) und Slicer (slicer.js), seit 10o. Global "ScriptSCADAbout".
// Enthält die Texte (de/en) und die Liste der mitgelieferten Open-Source-Bestandteile an EINER Stelle.
// Adressen werden bewusst als Text (nicht als Link) gezeigt: ein Link würde die WebView von Scriptable verlassen.
// Ausnahme Spenden-Button (10p): Aktion „openUrl“, Scriptable öffnet die Ko-fi-Seite mit Safari.open().
// Die vollständigen Lizenztexte liegen in iCloud Drive › Scriptable › ScriptSCAD › licenses.
(function (root) {
  'use strict';
  const REPO = 'https://github.com/DarthQuintus/ScriptSCAD-Suite';
  // Spenden (10p): einzige Adresse, die die App in Safari öffnen darf (main.js/slicer-main.js prüfen genau diese).
  const DONATE = 'https://ko-fi.com/darthquintus';
  const TEXT = {
    de: {
      title: 'Über & Lizenzen',
      open: 'Über & Lizenzen …',
      program: { studio: 'ScriptSCAD Studio', slicer: 'ScriptSCAD Slicer' },
      version: 'Version {v}',
      copyright: '© 2026 Anton Angierski. Freie Software unter der GNU General Public License, Version 3 oder neuer (GPL-3.0-or-later).',
      warranty: 'Dieses Programm wird OHNE JEDE GEWÄHRLEISTUNG bereitgestellt, auch ohne die Gewährleistung der Marktreife oder der Eignung für einen bestimmten Zweck. ' +
        'Du darfst es unter den Bedingungen der Lizenz weitergeben und verändern. G-Code vor dem Druck prüfen und Drucke beaufsichtigen.',
      source: 'Quellcode, Anleitung und Updates:',
      parts: 'Mitgelieferte Open-Source-Bestandteile',
      donateTitle: 'ScriptSCAD unterstützen',
      donateHint: 'ScriptSCAD ist kostenlos und bleibt es. Wenn es dir hilft, freue ich mich über eine kleine Spende – Betrag frei wählbar, mit Apple Pay, PayPal oder Karte über Ko-fi (öffnet Safari).',
      donateButton: '♥ Spenden über Ko-fi …',
      usedIn: { studio: 'Studio', slicer: 'Slicer', both: 'Studio + Slicer' },
      texts: 'Die vollständigen Lizenztexte und Quellenangaben liegen in der App „Dateien“ unter iCloud Drive › Scriptable › ScriptSCAD › licenses (README.txt).',
      trademarks: 'Unabhängiges Projekt, nicht verbunden mit OpenSCAD, UltiMaker, Apple, OpenAI, Anthropic oder dem Entwickler von Scriptable.',
      notes: {
        openscad: 'WebAssembly-Build aus openscad-playground 2.4.0; enthält u. a. CGAL (GPL-3.0-or-later), Manifold (Apache-2.0), Boost, Eigen, Clipper, FreeType, HarfBuzz, Fontconfig.',
        curaengine: 'WebAssembly-Build aus cura-wasm 1.5.2 (Lader MIT, © Cloud CNC); kleine Anpassungen laut docker/CuraEngine.patch im cura-wasm-Repository.',
        curadefs: 'Druckerdefinitionen aus Ultimaker Cura, über cura-wasm-definitions 1.5.1, unverändert.',
        bosl2: 'Fassung 2.0.716, unverändert.', nopscadlib: 'Commit 00ec2898c0a2, unverändert.', mcad: 'Unverändert.',
        fonts: 'Liberation Sans/Serif/Mono, Noto Sans (für text()); Space Grotesk, JetBrains Mono (Oberfläche).'
      }
    },
    en: {
      title: 'About & licenses',
      open: 'About & licenses …',
      program: { studio: 'ScriptSCAD Studio', slicer: 'ScriptSCAD Slicer' },
      version: 'Version {v}',
      copyright: '© 2026 Anton Angierski. Free software under the GNU General Public License, version 3 or later (GPL-3.0-or-later).',
      warranty: 'This program comes with ABSOLUTELY NO WARRANTY, without even the implied warranty of merchantability or fitness for a particular purpose. ' +
        'You may redistribute and modify it under the terms of the license. Check G-code before printing and supervise your prints.',
      source: 'Source code, instructions and updates:',
      parts: 'Included open source components',
      donateTitle: 'Support ScriptSCAD',
      donateHint: 'ScriptSCAD is free and will stay free. If it helps you, a small donation is very welcome – any amount, with Apple Pay, PayPal or card via Ko-fi (opens Safari).',
      donateButton: '♥ Donate via Ko-fi …',
      usedIn: { studio: 'Studio', slicer: 'Slicer', both: 'Studio + Slicer' },
      texts: 'The full license texts and source references are in the Files app under iCloud Drive › Scriptable › ScriptSCAD › licenses (README.txt).',
      trademarks: 'Independent project, not affiliated with OpenSCAD, UltiMaker, Apple, OpenAI, Anthropic or the developer of Scriptable.',
      notes: {
        openscad: 'WebAssembly build from openscad-playground 2.4.0; includes CGAL (GPL-3.0-or-later), Manifold (Apache-2.0), Boost, Eigen, Clipper, FreeType, HarfBuzz, Fontconfig and others.',
        curaengine: 'WebAssembly build from cura-wasm 1.5.2 (loader MIT, © Cloud CNC); small changes as listed in docker/CuraEngine.patch in the cura-wasm repository.',
        curadefs: 'Printer definitions from Ultimaker Cura, via cura-wasm-definitions 1.5.1, unmodified.',
        bosl2: 'Version 2.0.716, unmodified.', nopscadlib: 'Commit 00ec2898c0a2, unmodified.', mcad: 'Unmodified.',
        fonts: 'Liberation Sans/Serif/Mono, Noto Sans (for text()); Space Grotesk, JetBrains Mono (user interface).'
      }
    }
  };
  // Bestandteile: Name, Fassung, Lizenz (SPDX), Quelle, wo verwendet, Lizenzdatei in licenses/, Hinweis-Schlüssel
  const PARTS = [
    { id: 'openscad', name: 'OpenSCAD', ver: '2025.03.25 (ce5039f8a)', lic: 'GPL-2.0-or-later', url: 'https://github.com/openscad/openscad', in: 'studio', file: 'OpenSCAD-GPL-2.0.txt' },
    { id: 'curaengine', name: 'CuraEngine', ver: '4.6.1', lic: 'AGPL-3.0-or-later', url: 'https://github.com/Ultimaker/CuraEngine · https://github.com/Cloud-CNC/cura-wasm', in: 'slicer', file: 'CuraEngine-cura-wasm-AGPL-3.0.txt' },
    { id: 'curadefs', name: 'Cura printer definitions', ver: '', lic: 'LGPL-3.0-or-later', url: 'https://github.com/Ultimaker/Cura · https://github.com/Cloud-CNC/cura-wasm-definitions', in: 'slicer', file: 'Cura-Definitionen-LGPL-3.0.txt' },
    { id: 'three', name: 'three.js', ver: 'r170', lic: 'MIT', url: 'https://github.com/mrdoob/three.js', in: 'both', file: 'three.js-MIT.txt' },
    { id: 'codemirror', name: 'CodeMirror 6 / Lezer', ver: '', lic: 'MIT', url: 'https://codemirror.net', in: 'studio', file: 'CodeMirror-MIT.txt' },
    { id: 'bosl2', name: 'BOSL2', ver: '', lic: 'BSD-2-Clause', url: 'https://github.com/BelfrySCAD/BOSL2', in: 'studio', file: 'BOSL2-BSD-2-Clause.txt' },
    { id: 'mcad', name: 'MCAD', ver: '', lic: 'LGPL-2.1', url: 'https://github.com/openscad/MCAD', in: 'studio', file: 'MCAD-LGPL-2.1.txt' },
    { id: 'nopscadlib', name: 'NopSCADlib', ver: '', lic: 'GPL-3.0', url: 'https://github.com/nophead/NopSCADlib', in: 'studio', file: 'NopSCADlib-GPL-3.0.txt' },
    { id: 'fonts', name: 'Fonts', ver: '', lic: 'OFL-1.1', url: 'https://github.com/liberationfonts · https://github.com/notofonts · https://github.com/floriankarsten/space-grotesk · https://github.com/JetBrains/JetBrainsMono', in: 'both', file: 'Fonts-OFL-1.1.txt, Schriften-OFL-1.1.txt' }
  ];
  const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (m, k) => (o[k] != null ? o[k] : m));
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Spenden-Block (Überschrift, Hinweis, Button); onOpen schickt die Aktion „openUrl“ an Scriptable
  function donateBlock(lang, onOpen) {
    const t = TEXT[lang] || TEXT.en;
    const wrap = el('div', 'aboutDonate');
    wrap.appendChild(el('h4', null, t.donateTitle));
    wrap.appendChild(el('p', 'hint', t.donateHint));
    const b = el('button', null, t.donateButton);
    b.className = 'btnDonate';
    b.addEventListener('click', () => onOpen(DONATE));
    wrap.appendChild(b);
    return wrap;
  }
  // Baut den Inhalt in „box“: app = 'studio' | 'slicer'; die eigene App steht oben in der Liste
  function render(box, lang, app, version, onDonate) {
    const t = TEXT[lang] || TEXT.en;
    const wrap = el('div', 'about');
    wrap.appendChild(el('p', 'aboutProg', t.program[app] + ' · ' + fmt(t.version, { v: version })));
    wrap.appendChild(el('p', 'hint', t.copyright));
    wrap.appendChild(el('p', 'hint', t.warranty));
    const src = el('p', 'hint', t.source + ' ');
    src.appendChild(el('span', 'aboutUrl', REPO));
    wrap.appendChild(src);
    if (onDonate) wrap.appendChild(donateBlock(lang, onDonate));
    wrap.appendChild(el('h4', null, t.parts));
    const list = el('ul', 'aboutList');
    const order = PARTS.filter((p) => p.in === app).concat(PARTS.filter((p) => p.in === 'both'), PARTS.filter((p) => p.in !== app && p.in !== 'both'));
    for (const p of order) {
      const li = el('li');
      li.appendChild(el('b', null, p.name + (p.ver ? ' ' + p.ver : '')));
      li.appendChild(el('span', 'aboutLic', ' · ' + p.lic + ' · ' + t.usedIn[p.in]));
      if (t.notes[p.id]) li.appendChild(el('div', 'hint', t.notes[p.id]));
      li.appendChild(el('div', 'aboutUrl', p.url));
      list.appendChild(li);
    }
    wrap.appendChild(list);
    wrap.appendChild(el('p', 'hint', t.texts));
    wrap.appendChild(el('p', 'hint', t.trademarks));
    box.appendChild(wrap);
    return wrap;
  }
  root.ScriptSCADAbout = { render, donateBlock, text: (lang) => TEXT[lang] || TEXT.en, parts: PARTS, repo: REPO, donate: DONATE };
})(typeof window !== 'undefined' ? window : globalThis);
