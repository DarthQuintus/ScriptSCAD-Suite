// ScriptSCAD Slicer – Oberfläche (WebView). Global "App" für slicer-main.js.
// 9h: Slicen im Hintergrund (Web Worker, Abbrechen), Tastenkürzel. 9g: Parameter-Profile, eigene Drucker (Start-/End-G-Code), G-Code-Import.
// 9f: Reiter „Objekte“ (Lage, Drehung, Größe, Aufteilen, Duplizieren, Auf Fläche legen, Rückgängig). 9e.3: Druckplatten in Projektordnern.
// 9e.2: Aufbau und Verhalten wie Studio (Kopfzeile mit Symbolen, Titel = Druckplatte, Trennbalken, Titel in der Scriptable-Leiste im Hochformat).
// 9e: Druckplatte mit mehreren Objekten („+ STL“, automatisch anordnen, antippen = wählen, entfernen, benannt speichern/laden).
// 9d: Reiter links „Drucker | Parameter“, Zahlen-Regler „‹ Zahl ›“ (vctl.js), Druckerauswahl mit Suche, rechts „3D | Schicht | G-Code“.
// 9c: Regler (Einstellungen-Reiter), Druckerauswahl (eigene, allgemeine, Cura-Bibliothek), Einstellungen gespeichert.
// 9b: Studio-Layout. Links G-Code (nur lesen, an die Zeit gekoppelt) | Einstellungen; rechts 3D-Ansicht bzw. Schicht von oben,
// darunter Zeitachse (▶, Zeit-Regler) und Schicht-Regler. Oben: Slicen, G-Code exportieren (Teilen / In Dateien).
(function () {
  'use strict';
  const VERSION = '10o.1';
  const $ = (id) => document.getElementById(id);
  const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && k in v ? v[k] : ''));
  let T = window.SLICER_I18N.de;
  // ---------- Symbole wie Studio (Linien, Farbe = Textfarbe) ----------
  const { svg, iconButton, contentRect, safeTop } = UICommon; // 10b: gemeinsam mit Studio (ui-common.js)
  const ICON = {
    log: svg('<path d="M7 4h7l4 4v12H7Z M14 4v4h4 M9.5 12h6M9.5 15.5h6"/>'), // wie Studio
    add: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" opacity=".45"/><path d="M12 8.5v7M8.5 12h7"/>'), // Würfel mit Plus
    disk: svg('<path d="M5 4h11.5L20 7.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 4v5h7V4M7.5 20v-6h9v6"/>'), // Diskette
    save: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'), // wie Studios STL-/Speichern-Symbol
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/><circle cx="12" cy="12" r="7"/>'), // wie Studio
    undo: svg('<path d="M9 7 4.5 11.5 9 16M5 11.5h9a5 5 0 0 1 0 10h-2"/>'),
    redo: svg('<path d="M15 7l4.5 4.5L15 16M19 11.5h-9a5 5 0 0 0 0 10h2"/>'),
  };

  // ---------- Protokoll / Status ----------
  function log(msg) { const el = $('log'); el.textContent += '[' + (performance.now() / 1000).toFixed(2) + '] ' + msg + '\n'; }
  function status(msg, isErr) { $('status').textContent = msg || ''; $('status').classList.toggle('error', !!isErr); }
  function progress(f) { $('bar').style.width = f > 0 && f < 1 ? (f * 100).toFixed(1) + '%' : '0'; }
  let toastTimer = null;
  function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function logError(where, e) { log('FEHLER ' + where + ': ' + (e && e.stack || e)); queue({ type: 'log', msg: 'FEHLER ' + where + ': ' + (e && e.message || e) }); }
  window.addEventListener('error', (ev) => logError('Seite', ev.error || ev.message));

  // ---------- Aktionen an Scriptable (Abfrage mit Nummer + Bestätigung, wie Studio) ----------
  let actions = [], nextId = 1;
  function queue(a) { a._id = nextId++; actions.push(a); }
  function poll(ack) { actions = actions.filter((a) => a._id > ack); return JSON.stringify({ actions }); }

  // ---------- Dateien von Scriptable (base64 in Stücken) ----------
  const files = {};
  function fileBegin(name, total) { files[name] = { buf: new Uint8Array(total), off: 0 }; if (name === 'wasm') status(fmt(T.loadingEngine, { pct: 0 })); return true; }
  function fileAdd(name, b64) {
    const f = files[name];
    const s = atob(b64);
    for (let i = 0; i < s.length; i++) f.buf[f.off++] = s.charCodeAt(i);
    if (name === 'wasm') { progress(f.off / f.buf.length); status(fmt(T.loadingEngine, { pct: Math.round(f.off / f.buf.length * 100) })); }
    return true;
  }
  function takeFile(name) {
    const f = files[name];
    if (!f || f.off !== f.buf.length) throw new Error('Datei unvollständig: ' + name);
    delete files[name];
    return f.buf;
  }

  // ---------- Darstellung (wie Studio: Einstellung theme, sonst iPad) ----------
  const VIEWER_THEME = {
    dark: { bg: 0x161615, bed: 0x232321, grid: 0x34342f, edge: 0x6a6a65, model: 0xff4f1a, dim: 0x7a7a74 },
    light: { bg: 0xffffff, bed: 0xeaeae4, grid: 0xd2d2cb, edge: 0x8a8a84, model: 0xff4f1a, dim: 0x9a9a94 },
  };
  let themeSetting = 'system', deviceDark = null;
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effectiveTheme() {
    if (themeSetting === 'dark' || themeSetting === 'light') return themeSetting;
    if (darkQuery && darkQuery.matches) return 'dark';
    if (deviceDark != null) return deviceDark ? 'dark' : 'light';
    return darkQuery ? 'light' : 'dark';
  }
  function applyTheme() {
    const th = effectiveTheme();
    document.documentElement.dataset.theme = th;
    if (viewer) viewer.setTheme(VIEWER_THEME[th]);
    drawLayer();
  }

  // ---------- CuraEngine ----------
  let wasmModule = null, wasmBytes = null, engineSrc = null;
  const defs = {};
  async function engineFinish() {
    try {
      status(T.compiling); progress(0);
      await new Promise((r) => setTimeout(r, 30));
      for (const n of Object.keys(files)) if (n.startsWith('def:')) defs[n.slice(4)] = takeFile(n);
      const t0 = performance.now();
      wasmBytes = takeFile('wasm');
      wasmModule = await WebAssembly.compile(wasmBytes);
      const ms = Math.round(performance.now() - t0);
      log('CuraEngine kompiliert in ' + ms + ' ms, Definitionen: ' + Object.keys(defs).join(', '));
      status(T.engineReady);
      updateButtons();
      startWorker(); // Hintergrund-Prozess schon jetzt vorbereiten (erstes Slicen startet dann sofort)
      return JSON.stringify({ ok: true, compileMs: ms });
    } catch (e) { logError('engineFinish', e); status(fmt(T.error, { msg: e.message }), true); return JSON.stringify({ error: e.message }); }
  }

  // Einstellungen (9c): Standard (slicer/standard.json), Bibliothek (slicer/drucker.json), Zustand des Nutzers (ScriptSCAD/slicer/einstellungen.json)
  let standard = null, library = [];
  let state = null; // { printer, material, machine: {bedX…}, values: {…} }
  let profile = null; // berechnet: Drucker + Maschine + Werte (für SlicerCore)
  let material = 'PETG';
  const MACHINE_KEYS = ['bedX', 'bedY', 'bedZ', 'nozzle', 'filamentDiameter', 'flavor'];
  // 9g: eigene Profile (ScriptSCAD/slicer/profile.json): Parameter-Profile { Name: { material, values } } und eigene Drucker
  let profiles = { params: {}, printers: [] };
  function printerById(id) { return (standard && standard.printers.find((p) => p.id === id)) || profiles.printers.find((p) => p.id === id) || library.find((p) => p.id === id) || null; }
  function materialValues(pr, m) { return Object.assign({}, standard.materials[m] || {}, (pr && pr.materials && pr.materials[m]) || {}); }
  function machineOf(pr) { const o = {}; for (const k of MACHINE_KEYS) o[k] = pr[k]; if (!o.flavor) o.flavor = 'RepRap (Marlin/Sprinter)'; return o; }
  // Vorschläge des Druckers (Rückzug, Geschwindigkeiten) auf die Werte anwenden
  function suggestValues(pr) {
    const sg = (pr && pr.suggest) || {};
    const v = {};
    if (sg.retract != null) v.retract = sg.retract;
    if (sg.retractSpeed != null) v.retractSpeed = sg.retractSpeed;
    if (sg.speedPrint != null) {
      v.speedPrint = sg.speedPrint;
      v.speedOuterWall = sg.speedOuterWall != null ? sg.speedOuterWall : Math.round(sg.speedPrint / 2 / 5) * 5;
      v.speedInfill = sg.speedInfill != null ? sg.speedInfill : sg.speedPrint;
      v.speedFirstLayer = sg.speedFirstLayer != null ? sg.speedFirstLayer : Math.min(30, Math.round(sg.speedPrint / 2 / 5) * 5);
    }
    if (sg.travelSpeed != null) v.travelSpeed = sg.travelSpeed;
    return v;
  }
  function recompute() {
    const pr = printerById(state.printer) || standard.printers[0];
    profile = Object.assign({}, pr, state.machine, state.values, { name: pr.name });
    // im Reiter „Drucker“ geänderter Start-/End-G-Code (gilt bis zum Druckerwechsel bzw. bis er als eigener Drucker gespeichert wird)
    if (state.gcode) { profile.startGcode = state.gcode.start; profile.endGcode = state.gcode.end; }
    delete profile.materials; delete profile.suggest;
    material = state.material;
  }
  function defaultState(prId) {
    const pr = printerById(prId) || standard.printers[0];
    const m = standard.material;
    return { printer: pr.id, material: m, machine: machineOf(pr), values: Object.assign({}, standard.values, suggestValues(pr), materialValues(pr, m)) };
  }
  // Druckplatte: Objekte mit zentrierten Dreiecken (Mitte X/Y = 0, Unterseite Z = 0) und Lage x/y relativ zur Bettmitte
  // 9f: base = Grundform (wie geladen, zentriert), rot (° um X/Y/Z wie OpenSCAD), scale (Faktor je Achse) → tri/size werden daraus berechnet;
  // pre = Herkunft eines abgetrennten Teils ({ rot, scale, part }: Zustand des Ursprungs beim Aufteilen + Nummer des Teils) – zum Speichern/Laden
  let plate = { name: null, pid: null, objects: [] }; // objects: [{ id, name, src, base, pre, rot, scale, tri, size, x, y, rev }]
  let nextObjId = 1, selectedId = null, pending = 0, revCounter = 1;
  function rebuild(o) {
    const t = SlicerCore.transformTri(o.base, o.scale, o.rot);
    o.tri = t.tri; o.size = t.size; o.rev = revCounter++;
  }
  function makeObject(id, name, src, base, pre) {
    const o = { id, name, src, base, pre: pre || null, x: 0, y: 0, rot: [0, 0, 0], scale: [1, 1, 1], lock: true };
    rebuild(o);
    return o;
  }
  const selObj = () => plate.objects.find((o) => o.id === selectedId) || null;
  // ---------- Rückgängig / Wiederholen für die Druckplatte (wie Studio ↶ ↷) ----------
  let undoStack = [], redoStack = [], undoKey = null, undoT = 0;
  const snapshot = () => ({ sel: selectedId, objects: plate.objects.map((o) => Object.assign({}, o, { rot: o.rot.slice(), scale: o.scale.slice() })) });
  // key: aufeinanderfolgende Änderungen am selben Regler (< 0,8 s Pause) zählen als ein Schritt
  function pushUndo(key) {
    const now = performance.now();
    if (key && key === undoKey && now - undoT < 800) { undoT = now; return; }
    undoKey = key || null; undoT = now;
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
  }
  function restore(snap) {
    plate.objects = snap.objects.map((o) => Object.assign({}, o, { rot: o.rot.slice(), scale: o.scale.slice() }));
    selectedId = plate.objects.some((o) => o.id === snap.sel) ? snap.sel : null;
    undoKey = null;
    plateChanged();
    if (viewer) viewer.setSelected(selectedId);
    refreshPlate(false);
    if (!hasObjects()) status(T.emptyPlate);
  }
  function undo() { if (busy || !undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
  function redo() { if (busy || !redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
  const hasObjects = () => plate.objects.length > 0;
  let result = null; // { gcode, lines, tp, meta, ... }
  let busy = false;
  let viewer = null;

  async function slice() {
    if (!wasmModule || !hasObjects() || busy || pending) return;
    stopPlay();
    busy = true; updateButtons();
    result = null; renderResult();
    const t0 = performance.now();
    try {
      const p = Object.assign({}, profile);
      const chk = layoutCheck();
      const badIdx = chk.findIndex((c) => c.outside || c.tooHigh);
      if (badIdx >= 0) {
        const o = plate.objects[badIdx];
        const e = new Error(fmt(T.tooBig, { name: o.name, size: o.size.map((v) => v.toFixed(1)).join(' × '), bed: p.bedX + ' × ' + p.bedY + ' × ' + p.bedZ }));
        e.user = true; // Hinweis an den Nutzer, kein Programmfehler
        throw e;
      }
      const placed = SlicerCore.mergeObjects(plate.objects);
      const settings = SlicerCore.curaSettings(p);
      if (settings.missing.length) log('Unbekannte Platzhalter im Start-/End-Code: ' + settings.missing.join(', '));
      if (settings.unresolved.length) { const e = new Error(fmt(T.unresolved, { list: settings.unresolved.join(' ') })); e.user = true; throw e; } // Hinweis, kein Programmfehler
      status(fmt(T.slicing, { pct: 0 }));
      await new Promise((r) => setTimeout(r, 50)); // Statuszeile zeichnen lassen
      const job = { args: SlicerCore.commandArgs(settings, '/d', '/m.stl', '/o.gcode'), files: SlicerCore.definitions(p), stl: placed.stl };
      const tS = performance.now();
      let res = null;
      if (await startWorker()) {
        try { res = await runInWorker(job); workerProven = true; } catch (e) {
          if (e.user || workerProven) throw e;
          // Hintergrund-Prozess startet, kann aber nicht slicen (Gerät/WebView) → ab jetzt in der Seite
          workerOk = false; killWorker();
          log('Hintergrund-Slicen fehlgeschlagen (' + e.message + ') → Slicen in der Seite'); queue({ type: 'log', msg: 'Web Worker fehlgeschlagen: ' + e.message });
        }
      }
      if (!res) res = await runInPage(job);
      const sliceMs = performance.now() - tS;
      const raw = res.raw;
      if (!res.meta) throw new Error('CuraEngine ohne Ergebnisdaten');
      const meta = { flavor: res.meta.flavor, printTime: res.meta.printTime, volume: res.meta.volume, filamentMm: SlicerCore.filamentLength(res.meta.volume, p.filamentDiameter) };
      const gcode = SlicerCore.finishGcode(raw, meta, { layerHeight: p.layerHeight, version: VERSION, printer: p.name, model: plateTitle() });
      const tP = performance.now();
      const tp = SlicerCore.buildToolpaths(gcode, meta.printTime);
      const prepMs = performance.now() - tP;
      result = { stale: false, gcode, lines: gcode.split('\n'), tp, meta, size: placed.size, triangles: placed.triangles, sliceMs, totalMs: performance.now() - t0, worker: !!res.worker };
      const summary = plateTitle() + ' (' + plate.objects.length + ' Obj.), ' + material + ', ' + placed.triangles + ' Dreiecke, ' + tp.layerStart.length + ' Ebenen, ' + tp.count + ' Bahnstücke, Druckzeit ' +
        SlicerCore.fmtTime(meta.printTime) + ', Filament ' + (meta.filamentMm / 1000).toFixed(2) + ' m, Slicen ' + Math.round(sliceMs) + ' ms (' + (res.worker ? 'Hintergrund' : 'Seite') + '), Vorschau ' + Math.round(prepMs) + ' ms';
      log(summary);
      progress(0);
      renderResult();
      selectObject(null);
      queue({ type: 'gcodeReady', length: gcode.length, chunks: Math.max(1, Math.ceil(gcode.length / 524288)), summary, plateName: plate.name, pid: plate.pid, srcs: plate.objects.map((o) => o.src) });
    } catch (e) {
      if (e.user) { log('Nicht gesliced: ' + e.message); queue({ type: 'log', msg: 'Nicht gesliced: ' + e.message }); } else logError('slice', e);
      progress(0);
      status(fmt(T.error, { msg: e.message }), true);
    } finally {
      busy = false; cancelSlice = null; updateButtons();
    }
  }
  // ---------- CuraEngine ausführen: im Hintergrund (Web Worker: Seite bleibt bedienbar, Abbrechen möglich) oder in der Seite ----------
  let worker = null, workerOk = null, workerHasWasm = false, workerProven = false, cancelSlice = null;
  // Läuft im Worker (wird als Text übergeben → darf nichts von außen benutzen). window = self, CuraEngine kommt aus curaengine.js davor.
  function workerMain() {
    let mod = null, defs = null;
    self.onmessage = async (ev) => {
      const d = ev.data, out = [];
      try {
        if (d.wasm) { mod = await WebAssembly.compile(d.wasm); defs = d.defs; }
        let meta = null;
        self['cura-wasm-progress-callback'] = (x) => self.postMessage({ type: 'progress', x });
        self['cura-wasm-metadata-callback'] = (flavor, printTime, m1, m2, nozzle, vol) => { meta = { flavor, printTime, volume: vol }; };
        const M = await self.CuraEngine({
          noInitialRun: true, print: (t) => out.push(t), printErr: (t) => out.push(t),
          instantiateWasm: (imports, receive) => { WebAssembly.instantiate(mod, imports).then((i) => receive(i, mod)); return {}; },
          quit: (st, e) => { throw e; },
        });
        M.FS.mkdir('/d');
        for (const f of Object.keys(defs)) M.FS.writeFile('/d/' + f, defs[f]);
        for (const f of Object.keys(d.files)) M.FS.writeFile('/d/' + f, d.files[f]);
        M.FS.writeFile('/m.stl', d.stl);
        M.callMain(d.args);
        const raw = M.FS.readFile('/o.gcode', { encoding: 'utf8' });
        self.postMessage({ type: 'done', raw, meta, worker: true });
      } catch (e) { self.postMessage({ type: 'error', msg: String((e && e.message) || e), out: out.slice(-15) }); }
    };
    self.postMessage({ type: 'ready' });
  }
  function killWorker() { if (worker) { try { worker.terminate(); } catch (e) { /* egal */ } } worker = null; workerHasWasm = false; }
  // → true, wenn ein Hintergrund-Prozess bereitsteht (einmal je Start geprüft; scheitert er, bleibt es beim Slicen in der Seite)
  function startWorker() {
    if (worker) return Promise.resolve(true);
    if (workerOk === false || !engineSrc || typeof Worker === 'undefined' || typeof Blob === 'undefined') return Promise.resolve(false);
    return new Promise((resolve) => {
      let w = null, t = null, over = false;
      const fail = (why) => {
        if (over) return; over = true;
        clearTimeout(t); workerOk = false;
        try { if (w) w.terminate(); } catch (e) { /* egal */ }
        log('Hintergrund-Slicen nicht möglich (' + why + ') → Slicen in der Seite');
        queue({ type: 'log', msg: 'Web Worker nicht verfügbar: ' + why });
        resolve(false);
      };
      try {
        const url = URL.createObjectURL(new Blob(['var window = self;\n', engineSrc, '\n(', workerMain.toString(), ')();'], { type: 'text/javascript' }));
        w = new Worker(url);
      } catch (e) { fail(e.message || String(e)); return; }
      t = setTimeout(() => fail('keine Antwort'), 4000);
      w.onerror = (e) => fail((e && e.message) || 'Start gescheitert');
      w.onmessage = (ev) => {
        if (over || !ev.data || ev.data.type !== 'ready') return;
        over = true; clearTimeout(t);
        worker = w; workerOk = true; workerHasWasm = false;
        log('Hintergrund-Slicen bereit (Web Worker)');
        queue({ type: 'log', msg: 'Web Worker bereit' });
        resolve(true);
      };
    });
  }
  function runInWorker(job) {
    return new Promise((resolve, reject) => {
      const w = worker;
      const done = () => { w.onmessage = null; w.onerror = null; cancelSlice = null; };
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === 'progress') { progress(d.x); status(fmt(T.slicing, { pct: Math.round(d.x * 100) })); }
        else if (d.type === 'done') { done(); resolve(d); }
        else if (d.type === 'error') { done(); if (d.out && d.out.length) log('CuraEngine-Ausgabe:\n' + d.out.join('\n')); reject(new Error('CuraEngine: ' + d.msg)); }
      };
      w.onerror = (e) => { done(); killWorker(); reject(new Error('Worker: ' + ((e && e.message) || 'Abbruch'))); };
      cancelSlice = () => { done(); killWorker(); const e = new Error(T.sliceCancelled); e.user = true; reject(e); };
      updateButtons(); // „Slicen“ wird zu „Abbrechen“
      const msg = { type: 'slice', args: job.args, files: job.files, stl: job.stl };
      if (!workerHasWasm) { msg.wasm = wasmBytes; msg.defs = defs; workerHasWasm = true; }
      w.postMessage(msg);
    });
  }
  // Bisheriger Weg (bis 9e.2): in der Seite – sie reagiert währenddessen nicht
  async function runInPage(job) {
    let meta = null;
    const out = [];
    window['cura-wasm-progress-callback'] = (x) => progress(x);
    window['cura-wasm-metadata-callback'] = (flavor, printTime, m1, m2, nozzle, vol) => { meta = { flavor, printTime, volume: vol }; };
    const M = await window.CuraEngine({
      noInitialRun: true, print: (t) => out.push(t), printErr: (t) => out.push(t),
      instantiateWasm: (imports, receive) => { WebAssembly.instantiate(wasmModule, imports).then((i) => receive(i, wasmModule)); return {}; },
      quit: (st, e) => { throw e; },
    });
    M.FS.mkdir('/d');
    for (const [f, bytes] of Object.entries(defs)) M.FS.writeFile('/d/' + f, bytes);
    for (const [f, text] of Object.entries(job.files)) M.FS.writeFile('/d/' + f, text);
    M.FS.writeFile('/m.stl', job.stl);
    try { M.callMain(job.args); } catch (e) {
      log('CuraEngine-Ausgabe:\n' + out.slice(-15).join('\n'));
      throw new Error('CuraEngine: ' + ((e && e.message) || e));
    }
    let raw;
    try { raw = M.FS.readFile('/o.gcode', { encoding: 'utf8' }); } catch (e) { log(out.slice(-15).join('\n')); throw new Error('CuraEngine hat keinen G-Code geschrieben'); }
    return { raw, meta, worker: false };
  }
  function gcodeChunk(i, size) { return result ? result.gcode.slice(i * size, (i + 1) * size) : ''; }
  function gcodeSaved(info) {
    result.saved = info.path;
    status(fmt(T.sliced, { sec: (result.totalMs / 1000).toFixed(1) }) + ' ' + fmt(T.savedTo, { path: info.path }));
    updateButtons();
  }

  // ---------- Bildschirme ----------
  function updateButtons() {
    const canCancel = busy && !!cancelSlice;
    $('btnSlice').disabled = !wasmModule || !hasObjects() || pending > 0 || (busy && !canCancel);
    $('btnSlice').textContent = canCancel ? T.cancel : T.slice;
    $('btnExport').disabled = !(result && result.saved) || busy;
    $('btnAdd').disabled = busy;
    $('btnSavePlate').disabled = busy || !hasObjects();
  }
  const inProject = () => !$('screenProject').classList.contains('hidden');
  function showScreen(which) {
    $('screenList').classList.toggle('hidden', which !== 'list');
    $('screenProject').classList.toggle('hidden', which !== 'slice');
    $('btnBack').classList.toggle('hidden', which !== 'slice');
    document.querySelectorAll('.projOnly').forEach((e) => e.classList.toggle('hidden', which !== 'slice'));
    $('navTitle').classList.toggle('proj', which === 'slice');
    updateTitle();
    updateNavMode();
    applyLayout();
    if (which === 'slice') {
      if (!viewer) {
        viewer = window.SlicerViewer.createViewer($('stage'));
        viewer.setTheme(VIEWER_THEME[effectiveTheme()]);
        viewer.onTap((id) => { selectObject(id); if (id != null && selectedId != null) setTab('objects'); });
        if (profile) setViewerBed();
      }
      requestAnimationFrame(() => { viewer.resize(); drawLayer(); });
    }
  }
  // Statuszeile wie in Studio: beim Slicen als Hinweis oben in der Ansicht, in der Liste als Zeile
  function placeStatus() {
    const st = $('status');
    const inSlice = inProject() && !$('view').classList.contains('hidden');
    const parent = inSlice ? $('stage') : inProject() ? $('codePane') : $('screenList');
    if (st.parentNode !== parent) parent.insertBefore(st, inSlice ? null : inProject() ? $('paneTabs') : $('projectList'));
    st.classList.toggle('chip', inSlice);
    st.classList.toggle('line', !inSlice);
  }
  // Titel: Liste = App-Name, sonst Name der Druckplatte (wie Studio den Projektnamen)
  function updateTitle() {
    const t = inProject() ? (hasObjects() || plate.name ? plateTitle() : '…') : T.appName;
    $('titleText').textContent = t;
    $('navName').textContent = inProject() ? t : '';
  }
  // ---------- 8c wie Studio: Titel in der Scriptable-Leiste (nur Hochformat mit großem Abstand oben) ----------
  function updateNavMode() {
    const on = window.innerHeight > window.innerWidth && safeTop() >= 60;
    document.body.classList.toggle('navMode', on);
    document.body.classList.toggle('listScreen', !inProject());
    $('navTitle').classList.toggle('hidden', !on);
    // Liste im Hochformat: Kopfzeile entfällt → Protokoll-Knopf in die Listen-Überschrift
    const lb = $('btnLog'), head = document.querySelector('#screenList .listHead');
    if (on && !inProject()) { if (lb.parentNode !== head) head.appendChild(lb); } else if (lb.parentNode !== document.querySelector('header')) document.querySelector('header').appendChild(lb);
  }
  // ---------- Aufteilung links/rechts wie Studio (Trennbalken ziehen, doppelt tippen = Standard, ←/→) ----------
  const SPLIT_DEFAULT = { wide: 42, tall: 50 }, SPLIT_MIN_PX = 160;
  let split = null; // UICommon.splitter (10b)
  const isTall = () => getComputedStyle($('screenProject')).flexDirection === 'column';
  const splitKey = () => (isTall() ? 'splitTall' : 'splitWide');
  function splitPct() {
    const d = split && split.dragging();
    if (d != null) return d;
    const v = state && state.ui && state.ui[splitKey()];
    return typeof v === 'number' ? v : (isTall() ? SPLIT_DEFAULT.tall : SPLIT_DEFAULT.wide);
  }
  // Ansicht wie Studio: nur links | beides | nur rechts (in einstellungen.json → ui.viewMode)
  const viewModeSetting = () => { const m = state && state.ui && state.ui.viewMode; return m === 'edit' || m === 'view' ? m : 'both'; };
  function setPaneMode(m) {
    if (!state) return;
    state.ui = Object.assign({}, state.ui, { viewMode: m });
    applyLayout();
    scheduleSave();
  }
  function applyLayout() {
    const mode = viewModeSetting();
    $('codePane').classList.toggle('hidden', mode === 'view');
    $('view').classList.toggle('hidden', mode === 'edit');
    $('splitter').classList.toggle('hidden', mode !== 'both');
    for (const m of ['edit', 'both', 'view']) $('mode' + m[0].toUpperCase() + m.slice(1)).classList.toggle('on', m === mode);
    $('codePane').style.flex = mode === 'edit' ? '1 1 auto' : '0 0 ' + splitPct() + '%';
    placeStatus();
    if (viewer) requestAnimationFrame(() => { viewer.resize(); drawLayer(); });
  }
  function saveSplit(pct) {
    if (!state) return;
    state.ui = Object.assign({}, state.ui, { [splitKey()]: pct });
    applyLayout();
    scheduleSave();
  }
  function initSplitter() {
    split = UICommon.splitter({ el: $('splitter'), container: $('screenProject'), isTall, current: splitPct, defaults: SPLIT_DEFAULT, minPx: SPLIT_MIN_PX, layout: applyLayout, save: saveSplit });
    window.addEventListener('resize', () => { applyLayout(); updateNavMode(); });
  }
  let models = [], plates = [];
  const modelTitle = (m) => m.projectName + ' · ' + m.file.replace(/\.(stl|3mf|obj)$/i, '');
  const dateText = (t) => (t ? new Date(t).toLocaleString(document.documentElement.lang) : '');
  function listButton(title, sub, onClick) {
    const b = document.createElement('button');
    b.className = 'open';
    b.innerHTML = '<span class="name"></span><span class="date"></span>';
    b.querySelector('.name').textContent = title;
    b.querySelector('.date').textContent = sub;
    b.addEventListener('click', onClick);
    return b;
  }
  function renderList() {
    // gespeicherte Druckplatten
    const pl = $('plateList');
    pl.innerHTML = '';
    for (const p of plates) {
      const li = document.createElement('li');
      li.appendChild(listButton(p.name, fmt(T.plateObjects, { n: p.count }) + ' · ' + dateText(p.modified), () => loadPlate(p)));
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = T.deletePlate;
      del.addEventListener('click', async () => { if (await ask({ title: fmt(T.deletePlateQ, { name: p.name }), ok: T.delete, danger: true })) queue({ type: 'deletePlate', id: p.id }); });
      li.appendChild(del);
      pl.appendChild(li);
    }
    $('plateHead').classList.toggle('hidden', !plates.length);
    // Modelle: antippen = neue Druckplatte mit diesem Modell
    const ul = $('projectList');
    ul.innerHTML = '';
    for (const e of modelEntries()) {
      const li = document.createElement('li');
      li.appendChild(listButton(e.title, e.sub, () => newPlate(e.path)));
      ul.appendChild(li);
    }
    $('emptyList').classList.toggle('hidden', models.length > 0);
  }
  function modelEntries() {
    return [{ path: 'cube', title: T.testCube, sub: T.testCubeSub }].concat(models.map((m) => ({ path: m.path, title: modelTitle(m), sub: dateText(m.modified) })));
  }
  function resetPlate(name) {
    stopPlay();
    plate = { name: name || null, pid: null, objects: [] };
    selectedId = null; result = null;
    undoStack = []; redoStack = []; undoKey = null;
    showScreen('slice');
    renderResult();
    refreshPlate(true);
  }
  function newPlate(src) { resetPlate(null); addModel(src); }
  function loadPlate(p) { if (busy) return; queue({ type: 'loadPlate', id: p.id }); status(T.loadingModel); }
  // Gespeicherte Platte (von Scriptable gelesen): Objekte mit ihrer Lage nachladen
  function plateData(d) {
    resetPlate(d.name);
    plate.pid = d.pid || null;
    plate.manual = true; // gespeicherte Lage behalten
    for (const o of d.objects || []) addModel(o.src, { x: +o.x || 0, y: +o.y || 0, rot: o.rot, scale: o.scale, pre: o.pre }, o.name);
    if (!(d.objects || []).length) status(T.emptyPlate);
  }
  function addModel(src, pos, name) {
    pending++;
    status(T.loadingModel);
    queue({ type: 'addModel', src, key: nextObjId++, pos: pos || null, name: name || null });
    updateButtons();
  }
  async function modelLoaded(info) {
    let tri;
    try {
      const bytes = info.cube ? null : takeFile('model');
      tri = info.cube ? SlicerCore.cubeTri(20) : await SlicerCore.parseMesh(bytes, info.src); // 10j: STL, 3MF, OBJ
      if (!info.cube) {
        // 10j: prüfen + reparieren (Löcher, Ausrichtung, entartete/doppelte Dreiecke)
        const t0 = performance.now();
        const rep = SlicerCore.repairMesh(tri);
        const r = rep.report;
        log('Netz geprüft (' + Math.round(performance.now() - t0) + ' ms): ' + JSON.stringify(r));
        if (r.changed) {
          tri = rep.tri;
          const parts = [];
          if (r.holes) parts.push(fmt(T.repHoles, { n: r.holes }));
          if (r.flipped) parts.push(fmt(T.repFlipped, { n: r.flipped }));
          if (r.degenerate + r.duplicate) parts.push(fmt(T.repBad, { n: r.degenerate + r.duplicate }));
          toast(fmt(T.repDone, { name: info.name, list: parts.join(', ') }));
          queue({ type: 'log', msg: 'Netz repariert: ' + info.name + ' ' + JSON.stringify(r) });
        }
        if (r.openEdges) { toast(fmt(T.repOpen, { name: info.name, n: r.openEdges })); queue({ type: 'log', msg: 'Netz nicht dicht: ' + info.name + ', ' + r.openEdges + ' offene Kanten' }); }
      }
    } finally { pending = Math.max(0, pending - 1); }
    let base = SlicerCore.centerTri(tri).tri;
    const pos = info.pos || null;
    const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && isFinite(x)) ? v.slice() : d);
    let pre = null;
    if (pos && pos.pre && typeof pos.pre === 'object') {
      // abgetrenntes Teil: Ursprung so drehen/skalieren wie beim Aufteilen, dann dasselbe Teil heraussuchen
      pre = { rot: vec(pos.pre.rot, [0, 0, 0]), scale: vec(pos.pre.scale, [1, 1, 1]), part: pos.pre.part | 0 };
      const parts = SlicerCore.components(SlicerCore.transformTri(base, pre.scale, pre.rot).tri);
      if (!parts[pre.part]) throw new Error(T.partMissing);
      base = SlicerCore.centerTri(parts[pre.part]).tri;
    }
    const o = makeObject(info.key, info.name, info.src, base, pre);
    if (pos) {
      o.rot = vec(pos.rot, [0, 0, 0]); o.scale = vec(pos.scale, [1, 1, 1]).map((v) => (Math.abs(v) >= 0.01 ? v : 1));
      o.lock = o.scale[0] === o.scale[1] && o.scale[1] === o.scale[2];
      rebuild(o);
      o.x = pos.x; o.y = pos.y;
      plate.objects.push(o);
    } else { pushUndo(); plate.objects.push(o); if (plate.manual) placeFree(o); else arrangeAll(); }
    plateChanged();
    if (!pending) status(wasmModule ? T.engineReady : T.compiling);
    refreshPlate(true);
  }
  function modelFailed(info) {
    if (!info.counted) pending = Math.max(0, pending - 1); // counted: schon in modelLoaded abgezogen (10j)
    toast(fmt(T.modelFailed, { name: info.name || info.src, msg: info.msg }));
    if (!pending) status(hasObjects() ? (wasmModule ? T.engineReady : T.compiling) : T.emptyPlate, !hasObjects());
    updateButtons();
  }
  function arrangeAll() {
    const pos = SlicerCore.arrange(plate.objects, profile.bedX, profile.bedY, 5);
    plate.objects.forEach((o, i) => { o.x = pos[i].x; o.y = pos[i].y; });
  }
  function layoutCheck() {
    return SlicerCore.checkLayout(plate.objects, { w: profile.bedX, d: profile.bedY, h: profile.bedZ, round: profile.round });
  }
  // Objekte haben sich geändert → alte Vorschau passt nicht mehr
  function plateChanged() {
    if (result) { stopPlay(); result = null; renderResult(); }
  }
  const plateTitle = () => plate.name || (plate.objects.length === 1 ? plate.objects[0].name : fmt(T.plateObjects, { n: plate.objects.length }));
  // Ansicht + Kopf + Hinweise nach jeder Änderung der Platte
  function refreshPlate(fit, keepPane) {
    const chk = layoutCheck();
    if (viewer) viewer.setObjects(plate.objects.map((o, i) => ({ id: o.id, rev: o.rev, tri: o.tri, x: o.x, y: o.y, bad: chk[i].outside || chk[i].tooHigh })), { fit });
    updateTitle();
    const warn = [];
    chk.forEach((c, i) => { if (c.outside) warn.push(fmt(T.w_outside, { name: plate.objects[i].name })); if (c.tooHigh) warn.push(fmt(T.w_tooHigh, { name: plate.objects[i].name })); });
    if (chk.some((c) => c.overlap)) warn.push(T.w_overlap);
    $('plateWarn').textContent = warn.length ? '⚠︎ ' + warn.join(' ') : '';
    $('summary').classList.toggle('hidden', !warn.length);
    renderObjBar();
    if (!keepPane) renderObjects();
    drawLayer();
    updateButtons();
  }
  // ---------- Auswahl (antippen in der 3D-Ansicht) ----------
  function selectObject(id) {
    selectedId = plate.objects.some((o) => o.id === id) ? id : null;
    if (viewer) {
      viewer.setSelected(selectedId);
      // nach dem Slicen: Objekt antippen → Objekte statt Bahnen zeigen; ins Leere tippen → Bahnen wieder
      if (result) viewer.setPathsVisible(selectedId == null);
    }
    renderObjBar();
    renderObjects();
  }
  function renderObjBar() {
    const o = plate.objects.find((x) => x.id === selectedId);
    $('objBar').classList.toggle('hidden', !o);
    if (!o) return;
    $('objInfo').textContent = fmt(T.objInfo, { name: o.name, x: o.size[0].toFixed(1), y: o.size[1].toFixed(1), z: o.size[2].toFixed(1) });
  }
  function removeSelected() {
    if (busy || selectedId == null) return;
    pushUndo();
    plate.objects = plate.objects.filter((o) => o.id !== selectedId);
    selectedId = null;
    if (viewer) viewer.setSelected(null);
    plateChanged();
    refreshPlate(true);
    if (!hasObjects()) status(T.emptyPlate);
  }
  // ---------- Reiter „Objekte“ (9f): Liste + Lage, Drehung, Größe des gewählten Objekts ----------
  // Freien Platz für ein Objekt suchen (Raster 5 mm, möglichst nah an der Bettmitte), ohne die anderen zu verschieben; sonst alles neu anordnen
  function placeFree(o) {
    const bw = profile.bedX, bd = profile.bedY, gap = 5;
    const others = plate.objects.filter((x) => x !== o);
    const fits = (x, y) => {
      if (SlicerCore.checkLayout([{ size: o.size, x, y }], { w: bw, d: bd, h: 1e9, round: profile.round })[0].outside) return false;
      return !others.some((p) => Math.abs(x - p.x) < (o.size[0] + p.size[0]) / 2 + gap - 0.01 && Math.abs(y - p.y) < (o.size[1] + p.size[1]) / 2 + gap - 0.01);
    };
    if (fits(o.x, o.y)) return;
    // freie Stelle, die der Bettmitte am nächsten liegt
    let best = null;
    for (let y = -Math.floor(bd / 10) * 5; y <= bd / 2; y += 5) {
      for (let x = -Math.floor(bw / 10) * 5; x <= bw / 2; x += 5) {
        const d = x * x + y * y;
        if ((!best || d < best.d) && fits(x, y)) best = { x, y, d };
      }
    }
    if (best) { o.x = best.x; o.y = best.y; } else arrangeAll();
  }
  // Änderung am gewählten Objekt: Rückgängig-Schritt, neu berechnen, Ansicht erneuern (Regler-Fläche erst am Ende der Eingabe neu aufbauen)
  function editObject(key, fn, geometry) {
    const o = selObj();
    if (!o || busy) return false;
    pushUndo(o.id + ':' + key);
    fn(o);
    if (geometry) rebuild(o);
    plateChanged();
    refreshPlate(false, true);
    return true;
  }
  const dec = (v, d) => { const t = (+v).toFixed(d); return decimalComma() ? t.replace('.', ',') : t; };
  const parseNum = (x) => (typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.')));
  // ‹ Zahl › für Objekt-Werte (Aussehen wie in Studio: mehrere nebeneinander in einer Reihe)
  function objCtl(key, label, value, step, unit, digits, apply, limits) {
    const vc = window.ValueCtl.create({
      label, value, step, unit, drag: false,
      format: (x) => dec(x, digits),
      onCommit: (x) => {
        const n = parseNum(x);
        if (!isFinite(n) || (limits && (n < limits[0] || n > limits[1]))) return { ok: false };
        const v = +n.toFixed(digits);
        return { ok: apply(v) !== false, value: v };
      },
      onEnd: () => renderObjects(),
      onError: (w, e) => logError(w, e),
    });
    vc.el.dataset.key = key;
    return vc.el;
  }
  function renderObjects() {
    const box = $('objBox');
    if (!box || !profile) return;
    const a = document.activeElement;
    const fk = a && a.classList && a.classList.contains('vbar') && a.parentNode.dataset ? a.parentNode.dataset.key : null;
    const keepScroll = box.scrollTop;
    box.innerHTML = '';
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const tools = mk('div', 'pTools');
    const bU = mk('button', 'small tb iconOnly'); bU.id = 'btnUndo'; bU.innerHTML = ICON.undo; bU.title = T.undo; bU.setAttribute('aria-label', T.undo); bU.disabled = !undoStack.length || busy; bU.addEventListener('click', undo);
    const bR = mk('button', 'small tb iconOnly'); bR.id = 'btnRedo'; bR.innerHTML = ICON.redo; bR.title = T.redo; bR.setAttribute('aria-label', T.redo); bR.disabled = !redoStack.length || busy; bR.addEventListener('click', redo);
    const bA = mk('button', 'small', T.arrange); bA.id = 'btnArrange'; bA.disabled = plate.objects.length < 1 || busy;
    bA.addEventListener('click', () => { if (busy) return; pushUndo(); arrangeAll(); plate.manual = false; plateChanged(); refreshPlate(true); });
    tools.append(bU, bR, bA);
    box.appendChild(tools);
    box.appendChild(mk('div', 'objGroup', fmt(T.objCount, { n: plate.objects.length })));
    if (!plate.objects.length) { box.appendChild(mk('p', 'note', T.emptyPlate)); box.scrollTop = keepScroll; return; }
    const chk = layoutCheck();
    plate.objects.forEach((o, i) => {
      const row = mk('button', 'objRow' + (o.id === selectedId ? ' sel' : ''));
      row.dataset.id = o.id;
      row.appendChild(mk('span', 'arrow', '▸'));
      row.appendChild(mk('span', 'objName', o.name));
      row.appendChild(mk('span', 'objSum', o.size.map((v) => dec(v, 1)).join(' × ') + ' mm'));
      if (chk[i].outside || chk[i].tooHigh) row.appendChild(mk('span', 'objTag', chk[i].tooHigh ? T.tagTooHigh : T.tagOutside));
      row.addEventListener('click', () => selectObject(o.id === selectedId ? null : o.id));
      box.appendChild(row);
      if (o.id === selectedId) box.appendChild(inspector(o, mk));
    });
    if (selectedId == null) box.appendChild(mk('p', 'note', T.objHint));
    box.scrollTop = keepScroll;
    if (fk) { const b = box.querySelector('.vctl[data-key="' + fk + '"] .vbar'); if (b) b.focus({ preventScroll: true }); }
  }
  function inspector(o, mk) {
    const ins = mk('div', 'inspector');
    const head = (t) => ins.appendChild(mk('div', 'insHead', t));
    const row = () => ins.appendChild(mk('div', 'vrow'));
    const btnRow = () => ins.appendChild(mk('div', 'insBtns'));
    const button = (parent, id, text, fn, cls) => { const b = mk('button', 'small' + (cls ? ' ' + cls : ''), text); b.id = id; b.addEventListener('click', fn); parent.appendChild(b); return b; };
    // Lage (Mitte des Objekts, 0 = Bettmitte)
    head(T.objPosition);
    let r = row();
    r.appendChild(objCtl('posX', 'X', o.x, 1, 'mm', 1, (v) => editObject('posX', (q) => { q.x = v; plate.manual = true; })));
    r.appendChild(objCtl('posY', 'Y', o.y, 1, 'mm', 1, (v) => editObject('posY', (q) => { q.y = v; plate.manual = true; })));
    button(btnRow(), 'btnObjCenter', T.objCenter, () => { if (editObject('center', (q) => { q.x = 0; q.y = 0; plate.manual = true; })) renderObjects(); });
    // Drehung wie in OpenSCAD rotate([x, y, z]); das Objekt wird danach wieder aufs Bett gelegt
    head(T.objRotation);
    r = row();
    ['X', 'Y', 'Z'].forEach((ax, k) => r.appendChild(objCtl('rot' + ax, ax, o.rot[k], 5, '°', 1, (v) => editObject('rot' + ax, (q) => { q.rot[k] = ((v + 180) % 360 + 360) % 360 - 180; }, true), [-360, 360])));
    const rb = btnRow();
    button(rb, 'btnObjFlat', T.objLayFlat, layFlat);
    button(rb, 'btnObjRot0', T.objRotReset, () => { if (editObject('rot0', (q) => { q.rot = [0, 0, 0]; }, true)) renderObjects(); });
    // Größe: Prozent (gleichmäßig oder je Achse) und Maße in mm
    head(T.objSize);
    const lockRow = mk('div', 'setRow');
    lockRow.appendChild(mk('span', 'lbl', T.objUniform));
    const segs = mk('span', 'segs'); segs.id = 'objLock';
    for (const [val, key] of [[true, 'on'], [false, 'off']]) {
      const b = mk('button', '', T[key]); b.classList.toggle('on', !!o.lock === val);
      b.addEventListener('click', () => { o.lock = val; renderObjects(); });
      segs.appendChild(b);
    }
    lockRow.appendChild(segs);
    ins.appendChild(lockRow);
    const setScale = (k, f, key) => editObject(key, (q) => { if (q.lock) { const m = f / q.scale[k]; q.scale = q.scale.map((x) => +(x * m).toFixed(6)); } else q.scale[k] = +f.toFixed(6); }, true);
    r = row();
    if (o.lock) r.appendChild(objCtl('scale', T.objScale, o.scale[0] * 100, 1, '%', 1, (v) => setScale(0, v / 100, 'scale'), [1, 10000]));
    else ['X', 'Y', 'Z'].forEach((ax, k) => r.appendChild(objCtl('scale' + ax, ax, o.scale[k] * 100, 1, '%', 1, (v) => setScale(k, v / 100, 'scale' + ax), [1, 10000])));
    r = row();
    ['X', 'Y', 'Z'].forEach((ax, k) => r.appendChild(objCtl('size' + ax, ax, o.size[k], 1, 'mm', 1, (v) => {
      const cur = selObj();
      if (!cur || cur.size[k] < 1e-6) return false;
      const f = cur.scale[k] * (v / cur.size[k]);
      if (!(f >= 0.01 && f <= 100)) return false;
      return setScale(k, f, 'size' + ax);
    }, [0.1, 5000])));
    button(btnRow(), 'btnObjScale1', T.objScaleReset, () => { if (editObject('scale1', (q) => { q.scale = [1, 1, 1]; q.lock = true; }, true)) renderObjects(); });
    // Aktionen
    head(T.objActions);
    const ab = btnRow();
    button(ab, 'btnObjDup', T.objDuplicate, duplicateSelected);
    button(ab, 'btnObjSplit', T.objSplit, splitSelected);
    button(ab, 'btnObjRemove', T.remove, removeSelected, 'danger');
    return ins;
  }
  function duplicateSelected() {
    const o = selObj();
    if (!o || busy) return;
    pushUndo();
    const n = Object.assign({}, o, { id: nextObjId++, rot: o.rot.slice(), scale: o.scale.slice(), pre: o.pre ? Object.assign({}, o.pre) : null, name: copyName(o.name) });
    n.x = o.x + o.size[0] + 5;
    plate.objects.push(n);
    placeFree(n);
    selectedId = n.id;
    plateChanged();
    if (viewer) viewer.setSelected(selectedId);
    refreshPlate(false);
  }
  // „Halter“ → „Halter (2)“ → „Halter (3)“ (freier Name auf der Platte)
  function copyName(name) {
    const base = String(name).replace(/ \(\d+\)$/, '');
    const used = new Set(plate.objects.map((x) => x.name));
    for (let n = 2; ; n++) if (!used.has(base + ' (' + n + ')')) return base + ' (' + n + ')';
  }
  // Aufteilen: zusammenhängende Teile werden eigene Objekte (bleiben liegen, wo sie sind; schwebende Teile sinken aufs Bett)
  function splitSelected() {
    const o = selObj();
    if (!o || busy) return;
    const parts = o.pre ? [] : SlicerCore.components(o.tri);
    if (parts.length < 2) { toast(T.splitOne); return; }
    if (parts.length > 40) { toast(fmt(T.splitMany, { n: parts.length })); return; }
    pushUndo();
    const news = parts.map((tri, i) => {
      const fc = SlicerCore.footCenter(tri);
      const n = makeObject(nextObjId++, o.name + ' · ' + (i + 1), o.src, SlicerCore.centerTri(tri).tri, { rot: o.rot.slice(), scale: o.scale.slice(), part: i });
      n.x = +(o.x + fc[0]).toFixed(3); n.y = +(o.y + fc[1]).toFixed(3);
      return n;
    });
    const idx = plate.objects.indexOf(o);
    plate.objects.splice(idx, 1, ...news);
    plate.manual = true;
    selectedId = news[0].id;
    plateChanged();
    if (viewer) viewer.setSelected(selectedId);
    refreshPlate(false);
    toast(fmt(T.splitDone, { n: news.length }));
  }
  // Auf Fläche legen: größte ebene Außenfläche nach unten; erneut antippen = nächstkleinere Fläche
  function layFlat() {
    const o = selObj();
    if (!o || busy) return;
    const M = SlicerCore.eulerToMat(o.rot);
    const faces = SlicerCore.flatFaces(SlicerCore.applyMat(o.base, M), 12);
    if (!faces.length) { toast(T.noFlat); return; }
    const down = faces.find((f) => f.n[2] < -0.999);
    let f = faces[0];
    if (down) f = faces.find((x) => x.area < down.area * 0.99) || (faces[0].area > down.area * 1.01 ? faces[0] : null);
    if (!f) { toast(T.noFlat); return; }
    if (editObject('flat' + performance.now(), (q) => { q.rot = SlicerCore.matToEuler(SlicerCore.matMul(SlicerCore.alignMat(f.n, [0, 0, -1]), M)); }, true)) renderObjects();
  }
  // ---------- „+ STL“: Modell zur Platte hinzufügen ----------
  function openAdd() {
    if (busy) return;
    const ul = $('addList');
    ul.innerHTML = '';
    for (const e of modelEntries()) {
      const li = document.createElement('li');
      li.appendChild(listButton(e.title, e.sub, () => { closeAdd(); addModel(e.path); }));
      ul.appendChild(li);
    }
    $('addDialog').classList.remove('hidden');
  }
  function closeAdd() { $('addDialog').classList.add('hidden'); }
  // ---------- Druckplatte speichern ----------
  async function savePlate() {
    if (busy || !hasObjects()) return;
    const name = await ask({ title: T.savePlate, text: T.plateNamePrompt, input: plate.name || T.newPlateName, ok: T.save });
    if (!name || !String(name).trim()) return;
    const n = String(name).trim().slice(0, 60);
    const data = { version: 2, name: n, printer: state.printer, objects: plate.objects.map((o) => ({ src: o.src, name: o.name, x: +o.x.toFixed(3), y: +o.y.toFixed(3), rot: o.rot, scale: o.scale, pre: o.pre || undefined })) };
    queue({ type: 'savePlate', name: n, data: JSON.stringify(data) });
  }
  function plateSaved(info) {
    plate.name = info.name; plate.pid = info.pid || null;
    // importierte STL liegen jetzt als Kopie im Plattenordner → Quelle der Objekte nachziehen
    if (Array.isArray(info.srcs) && info.srcs.length === plate.objects.length) plate.objects.forEach((o, i) => { o.src = info.srcs[i]; });
    refreshPlate(false);
    toast(fmt(T.plateSaved, { name: info.name }));
  }
  // ---------- Frage-Dialog (eigener, kein confirm/prompt in der WebView) ----------
  let askResolve = null;
  function ask(o) {
    if (askResolve) askResolve(null);
    $('askTitle').textContent = o.title || '';
    $('askText').textContent = o.text || '';
    const inp = $('askInput');
    inp.classList.toggle('hidden', o.input == null);
    inp.value = o.input == null ? '' : o.input;
    $('btnAskOk').textContent = o.ok || T.ok;
    $('btnAskCancel').textContent = T.cancel;
    $('btnAskAlt').classList.toggle('hidden', !o.alt); // 10m: dritte Wahl, z. B. „Nur hochladen“
    if (o.alt) { $('btnAskAlt').textContent = o.alt.label; askAltValue = o.alt.value; }
    $('btnAskOk').classList.toggle('dangerFill', !!o.danger);
    $('btnAskOk').classList.toggle('primary', !o.danger);
    $('askDialog').classList.remove('hidden');
    if (o.input != null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    return new Promise((r) => { askResolve = r; });
  }
  let askAltValue = null;
  function askAlt() { $('askDialog').classList.add('hidden'); const r = askResolve; askResolve = null; if (r) r(askAltValue); }
  function askDone(ok) {
    $('askDialog').classList.add('hidden');
    const r = askResolve; askResolve = null;
    if (r) r(ok ? ($('askInput').classList.contains('hidden') ? true : $('askInput').value) : null);
  }
  function setViewerBed() { viewer.setBed(profile.bedX, profile.bedY, profile.bedZ, { centerZero: profile.centerZero, round: profile.round }); }
  function renderPrinterLine() {
    if (!profile) return;
    $('printerLine').textContent = fmt(T.printerLine, { printer: profile.name, material: material + ' ' + profile.nozzleTemp + '/' + profile.bedTemp + ' °C' });
  }

  // ---------- Einstellungen-Reiter: Drucker + Regler ----------
  const flavorName = (f) => (/marlin/i.test(f) ? 'Marlin' : /repetier/i.test(f) ? 'Repetier' : 'RepRapFirmware');
  function labelOf(item, o) {
    if (item.key === 'nozzle' || item.key === 'filamentDiameter') return String(o).replace('.', T === window.SLICER_I18N.de ? ',' : '.');
    return T['o_' + o] || String(o);
  }
  const decimalComma = () => T === window.SLICER_I18N.de;
  function fmtValue(item, v) {
    const d = (String(item.step).split('.')[1] || '').length;
    const t = (+v).toFixed(d);
    return decimalComma() ? t.replace('.', ',') : t;
  }
  // Neu aufbauen, Fokus (Hardware-Tastatur ←/→) auf demselben Regler behalten
  function renderSettings() {
    const a = document.activeElement;
    const row = a && a.closest && a.closest('.ctl');
    const key = row && a.classList.contains('vbar') ? row.dataset.key : null;
    renderPrinterPane(); renderParams();
    if (key) { const b = document.querySelector('.ctl[data-key="' + key + '"] .vbar'); if (b) b.focus({ preventScroll: true }); }
  }
  const secHead = (box, id) => { const h = document.createElement('h4'); h.className = 'secHead'; h.textContent = T['sec_' + id]; box.appendChild(h); };
  // Reiter „Drucker“: Auswahl (mit Suche), Bett, Düse, Filament, Dialekt
  function renderPrinterPane() {
    if (!standard || !state) return;
    const box = $('printerPane');
    const keepScroll = box.scrollTop;
    box.innerHTML = '';
    secHead(box, 'printer');
    const pr = printerById(state.printer);
    const rowP = document.createElement('div'); rowP.className = 'setRow';
    const btn = document.createElement('button'); btn.id = 'printerBtn';
    btn.innerHTML = '<span class="pname"></span><span class="pmore"></span>';
    btn.querySelector('.pname').textContent = printerLabel(pr || { name: profile.name });
    btn.querySelector('.pmore').textContent = T.choosePrinter;
    btn.addEventListener('click', openPicker);
    rowP.appendChild(btn);
    box.appendChild(rowP);
    // 10c: Drucker aus einer G-Code-Datei des bisherigen Slicers anlegen (gleicher Ablauf wie „G-Code importieren …“ in der Liste)
    const rowI = document.createElement('div'); rowI.className = 'setRow';
    const bi = document.createElement('button'); bi.id = 'btnImportPrinter'; bi.className = 'small'; bi.textContent = T.addPrinterGcode;
    bi.addEventListener('click', () => { if (!busy) queue({ type: 'importGcode' }); });
    rowI.appendChild(bi);
    // 10e: eigene Drucker + Parameter-Profile als eine Datei teilen (Import über „Drucker aus G-Code …“ bzw. „G-Code importieren …“)
    const bx = document.createElement('button'); bx.id = 'btnExportProfiles'; bx.className = 'small'; bx.textContent = T.exportProfiles;
    bx.disabled = !profiles.printers.length && !Object.keys(profiles.params).length;
    bx.addEventListener('click', exportProfiles);
    rowI.appendChild(bx);
    box.appendChild(rowI);
    const info = document.createElement('p'); info.className = 'note'; info.id = 'printerInfo';
    info.textContent = fmt(T.printerInfo, { flavor: flavorName(profile.flavor), x: profile.bedX, y: profile.bedY, z: profile.bedZ, round: profile.round ? T.roundBed : '' }) + (pr && pr.note ? ' · ' + pr.note : '');
    box.appendChild(info);
    secHead(box, 'machine');
    for (const item of SlicerSettings.MACHINE) box.appendChild(control(item, state.machine, 'machine'));
    const note = document.createElement('p'); note.className = 'note'; note.textContent = T.machineNote; box.appendChild(note);
    // 9g: Start-/End-G-Code bearbeiten, als eigenen Drucker speichern
    secHead(box, 'gcode');
    for (const [id, key, label] of [['startGcode', 'start', T.l_startGcode], ['endGcode', 'end', T.l_endGcode]]) {
      const l = document.createElement('label'); l.className = 'gcLabel'; l.textContent = label; l.htmlFor = id; box.appendChild(l);
      const ta = document.createElement('textarea'); ta.id = id; ta.className = 'gcEdit'; ta.spellcheck = false; ta.autocapitalize = 'off'; ta.autocomplete = 'off';
      ta.setAttribute('autocorrect', 'off');
      ta.value = profile[id] || '';
      ta.rows = Math.max(4, Math.min(14, ta.value.split('\n').length + 1));
      ta.addEventListener('input', () => {
        const g = state.gcode || { start: profile.startGcode || '', end: profile.endGcode || '' };
        g[key] = ta.value;
        state.gcode = g;
        changed(false);
        updatePrinterButtons();
      });
      box.appendChild(ta);
    }
    const gn = document.createElement('p'); gn.className = 'note'; gn.textContent = T.gcodeNote; box.appendChild(gn);
    const rowB = document.createElement('div'); rowB.className = 'setRow';
    const bs = document.createElement('button'); bs.id = 'btnSavePrinter'; bs.textContent = T.savePrinter; bs.addEventListener('click', savePrinter); rowB.appendChild(bs);
    const br = document.createElement('button'); br.id = 'btnResetGcode'; br.textContent = T.resetGcode; br.addEventListener('click', () => { state.gcode = null; changed(true); }); rowB.appendChild(br);
    const bd = document.createElement('button'); bd.id = 'btnDeletePrinter'; bd.className = 'danger'; bd.textContent = T.deletePrinter; bd.addEventListener('click', deletePrinter); rowB.appendChild(bd);
    box.appendChild(rowB);
    renderNetSection(box); // 10m
    updatePrinterButtons();
    box.scrollTop = keepScroll;
  }
  // ---------- 10m: Drucker im Netzwerk (OctoPrint, Moonraker/Klipper, PrusaLink) ----------
  const NET_TYPES = ['off', 'octoprint', 'moonraker', 'prusalink'];
  let netKeySaved = false, netStatusText = '';
  const netOn = () => !!(state && state.net && state.net.type !== 'off' && state.net.url);
  function renderNetSection(box) {
    secHead(box, 'net');
    const net = state.net || { type: 'off', url: '' };
    const rowT = document.createElement('div'); rowT.className = 'setRow ctl'; rowT.dataset.key = 'netType';
    const lt = document.createElement('span'); lt.className = 'lbl'; lt.textContent = T.l_netType; rowT.appendChild(lt);
    const segs = document.createElement('span'); segs.className = 'segs';
    for (const t of NET_TYPES) {
      const b = document.createElement('button'); b.textContent = T['net_' + t]; b.dataset.val = t; b.classList.toggle('on', net.type === t);
      b.addEventListener('click', () => { state.net = Object.assign({ url: '' }, state.net, { type: t }); scheduleSave(); renderPrinterPane(); });
      segs.appendChild(b);
    }
    rowT.appendChild(segs);
    box.appendChild(rowT);
    if (net.type === 'off') { const n = document.createElement('p'); n.className = 'note'; n.textContent = T.netOffNote; box.appendChild(n); return; }
    const field = (id, label, value, type, ph) => {
      const r = document.createElement('div'); r.className = 'setRow netRow';
      const l = document.createElement('label'); l.className = 'lbl'; l.textContent = label; l.htmlFor = id; r.appendChild(l);
      const i = document.createElement('input'); i.id = id; i.type = type; i.value = value || ''; i.placeholder = ph || ''; i.autocapitalize = 'off'; i.setAttribute('autocorrect', 'off'); i.spellcheck = false;
      r.appendChild(i); box.appendChild(r); return { r, i };
    };
    const u = field('netUrl', T.l_netUrl, net.url, 'url', 'http://192.168.1.50');
    u.i.addEventListener('change', () => { state.net = Object.assign({}, state.net, { url: u.i.value.trim() }); scheduleSave(); });
    const k = field('netKey', T.l_netKey, '', 'password', netKeySaved ? T.netKeyStored : (net.type === 'moonraker' ? T.netKeyOptional : ''));
    const bk = document.createElement('button'); bk.className = 'small'; bk.id = 'btnNetKey'; bk.textContent = T.netKeySave;
    bk.addEventListener('click', () => { queue({ type: 'netKey', key: k.i.value }); netKeySaved = !!k.i.value; k.i.value = ''; k.i.placeholder = netKeySaved ? T.netKeyStored : ''; toast(netKeySaved ? T.netKeySavedToast : T.netKeyRemoved); });
    k.r.appendChild(bk);
    const n = document.createElement('p'); n.className = 'note'; n.textContent = T.netNote; box.appendChild(n);
    const rowB = document.createElement('div'); rowB.className = 'setRow';
    const bt = document.createElement('button'); bt.id = 'btnNetTest'; bt.textContent = T.netTest;
    bt.addEventListener('click', () => { if (u.i.value.trim() !== (state.net.url || '')) { state.net.url = u.i.value.trim(); scheduleSave(); } netStatusText = T.netTesting; $('netStatus').textContent = netStatusText; queue({ type: 'netTest', net: state.net }); });
    rowB.appendChild(bt);
    box.appendChild(rowB);
    const st = document.createElement('p'); st.className = 'note'; st.id = 'netStatus'; st.textContent = netStatusText; box.appendChild(st);
  }
  function netResult(r) {
    netStatusText = r.ok ? fmt(T.netOk, { info: r.info || '' }) : fmt(T.netFail, { msg: r.msg || '' });
    if ($('netStatus')) $('netStatus').textContent = netStatusText;
    if (r.upload) { status(netStatusText, !r.ok); toast(netStatusText); }
  }
  async function sendToPrinter() {
    closeExport();
    if (!netOn() || !result || !result.saved) return;
    const start = await ask({ title: fmt(T.netSendTitle, { name: T['net_' + state.net.type] }), text: fmt(T.netSendText, { url: state.net.url }), ok: T.netUploadPrint, alt: { label: T.netUploadOnly, value: false } });
    if (start === null) return;
    status(T.netSending);
    queue({ type: 'netSend', net: state.net, print: !!start });
  }
  const isUserPrinter = (id) => profiles.printers.some((p) => p.id === id);
  function updatePrinterButtons() {
    if ($('btnResetGcode')) $('btnResetGcode').classList.toggle('hidden', !state.gcode);
    if ($('btnDeletePrinter')) $('btnDeletePrinter').classList.toggle('hidden', !isUserPrinter(state.printer));
  }
  function saveProfiles() {
    queue({ type: 'saveProfiles', data: JSON.stringify({ version: 1, params: profiles.params, printers: profiles.printers }) });
    if ($('btnExportProfiles')) $('btnExportProfiles').disabled = !profiles.printers.length && !Object.keys(profiles.params).length;
  }
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'drucker';
  // Aktuellen Drucker (Maschine + Start-/End-G-Code) unter einem Namen als eigenen Drucker ablegen; gleicher Name = überschreiben
  function storePrinter(name, extra) {
    const pr = printerById(state.printer) || standard.printers[0];
    const n = String(name).trim().slice(0, 60);
    let ex = profiles.printers.find((p) => p.name.toLowerCase() === n.toLowerCase());
    let id = ex ? ex.id : 'eigen-u-' + slug(n);
    if (!ex) for (let k = 2; printerById(id); k++) id = 'eigen-u-' + slug(n) + '-' + k;
    const np = Object.assign({ id, name: n, maker: '', note: T.ownPrinterNote, user: true, centerZero: !!pr.centerZero, round: !!pr.round, heatedBed: pr.heatedBed !== false,
      startGcode: profile.startGcode || '', endGcode: profile.endGcode || '' }, state.machine, extra || {});
    np.id = id; np.name = n; np.user = true;
    profiles.printers = profiles.printers.filter((p) => p.id !== id).concat([np]);
    saveProfiles();
    return np;
  }
  async function savePrinter() {
    if (busy) return;
    const cur = printerById(state.printer);
    const name = await ask({ title: T.savePrinter, text: T.savePrinterText, input: isUserPrinter(state.printer) ? cur.name : fmt(T.ownPrinterName, { name: cur ? cur.name : '' }), ok: T.save });
    if (!name || !String(name).trim()) return;
    const np = storePrinter(name);
    state.gcode = null;
    state.recent = [np.id].concat((state.recent || []).filter((r) => r !== np.id)).slice(0, 5);
    state.printer = np.id;
    state.machine = machineOf(np);
    changed(true, true);
    toast(fmt(T.printerSaved, { name: np.name }));
  }
  async function deletePrinter() {
    if (busy || !isUserPrinter(state.printer)) return;
    const cur = printerById(state.printer);
    if (!(await ask({ title: fmt(T.deletePrinterQ, { name: cur.name }), ok: T.delete, danger: true }))) return;
    profiles.printers = profiles.printers.filter((p) => p.id !== cur.id);
    saveProfiles();
    state.recent = (state.recent || []).filter((r) => r !== cur.id);
    selectPrinter(standard.printer);
  }
  // ---------- Parameter-Profile (9g; wie Studios Vorlagen): Material + alle Druckeinstellungen, unabhängig vom Drucker ----------
  const paramItems = () => [].concat(...SlicerSettings.SECTIONS.map((S) => S.items));
  function profileMatch() {
    for (const [name, pf] of Object.entries(profiles.params)) {
      if (pf.material !== state.material) continue;
      if (paramItems().every((it) => pf.values[it.key] === undefined || pf.values[it.key] === state.values[it.key])) return name;
    }
    return null;
  }
  function profileBar() {
    const bar = document.createElement('div'); bar.className = 'presetBar'; bar.id = 'profBar';
    const sel = document.createElement('select'); sel.id = 'profSel';
    const names = Object.keys(profiles.params).sort((a, b) => a.localeCompare(b));
    const match = profileMatch();
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = names.length ? T.profChoose : T.profNone; sel.appendChild(ph);
    for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
    sel.value = match || '';
    sel.disabled = !names.length;
    sel.addEventListener('change', () => { if (sel.value) applyProfile(sel.value); });
    const bS = document.createElement('button'); bS.className = 'small'; bS.id = 'profSave'; bS.textContent = T.profSave; bS.addEventListener('click', saveProfile);
    const bD = document.createElement('button'); bD.className = 'small'; bD.id = 'profDel'; bD.textContent = T.profDelete; bD.disabled = !match; bD.addEventListener('click', deleteProfile);
    bar.append(sel, bS, bD);
    return bar;
  }
  function applyProfile(name) {
    const pf = profiles.params[name];
    if (!pf || busy) return;
    if (standard.materials[pf.material]) state.material = pf.material;
    for (const it of paramItems()) if (pf.values[it.key] !== undefined) { const c = SlicerSettings.clean(it, pf.values[it.key]); if (c !== null) state.values[it.key] = c; }
    changed(true);
    toast(fmt(T.profApplied, { name }));
  }
  async function saveProfile() {
    if (busy) return;
    const name = await ask({ title: T.profSaveTitle, text: T.profSaveText, input: profileMatch() || $('profSel').value || state.material, ok: T.save });
    if (!name || !String(name).trim()) return;
    const n = String(name).trim().slice(0, 60);
    const values = {};
    for (const it of paramItems()) values[it.key] = state.values[it.key];
    profiles.params[n] = { material: state.material, values };
    saveProfiles();
    renderParams();
    toast(fmt(T.profSaved, { name: n }));
  }
  async function deleteProfile() {
    const name = profileMatch();
    if (!name || busy) return;
    if (!(await ask({ title: fmt(T.profDeleteQ, { name }), ok: T.delete, danger: true }))) return;
    delete profiles.params[name];
    saveProfiles();
    renderParams();
  }
  // ---------- 10e: Drucker + Profile als Datei teilen / übernehmen ----------
  const PROFILE_FORMAT = 'scriptscad-profiles';
  function exportProfiles() {
    if (busy) return;
    const data = { format: PROFILE_FORMAT, version: 1, created: new Date().toISOString(), printers: profiles.printers, params: profiles.params };
    queue({ type: 'exportProfiles', data: JSON.stringify(data, null, 1) });
  }
  async function profilesImport(d, name) {
    const printers = Array.isArray(d.printers) ? d.printers.filter((p) => p && typeof p.id === 'string' && /^eigen-u-/.test(p.id) && p.name && p.bedX > 0 && p.bedY > 0 && p.bedZ > 0) : [];
    const params = {};
    if (d.params && typeof d.params === 'object') for (const [n, pf] of Object.entries(d.params)) if (pf && typeof pf.values === 'object') params[String(n).slice(0, 60)] = { material: String(pf.material || ''), values: pf.values };
    const np = Object.keys(params).length;
    if (!printers.length && !np) { await ask({ title: T.importTitle, text: fmt(T.importNothing, { name }), ok: T.ok }); return; }
    const same = printers.filter((p) => profiles.printers.some((q) => q.id === p.id)).length + Object.keys(params).filter((n) => profiles.params[n]).length;
    const text = fmt(T.profImportText, { printers: printers.length, params: np }) + (same ? '\n' + fmt(T.profImportSame, { n: same }) : '');
    if (!(await ask({ title: T.profImportTitle, text, ok: T.importApply }))) return;
    for (const p of printers) { const i = profiles.printers.findIndex((q) => q.id === p.id); if (i >= 0) profiles.printers[i] = p; else profiles.printers.push(p); }
    Object.assign(profiles.params, params);
    saveProfiles();
    queue({ type: 'log', msg: 'Profile übernommen aus ' + name + ': ' + printers.length + ' Drucker, ' + np + ' Profile' });
    if (state) { renderPrinterPane(); renderParams(); }
    toast(fmt(T.profImportDone, { printers: printers.length, params: np }));
  }
  // ---------- G-Code-Import (9g): Einstellungen einer anderen Slicer-App übernehmen ----------
  async function gcodeImport(info) {
    const text = new TextDecoder().decode(takeFile('import'));
    // 10e: geteilte Profil-Datei (JSON) statt G-Code?
    if (/^\s*\{/.test(text)) {
      let d = null;
      try { d = JSON.parse(text); } catch (e) { /* kein JSON → wie G-Code behandeln */ }
      if (d && d.format === PROFILE_FORMAT) return profilesImport(d, info.name);
    }
    const r = SlicerImport.parse(text, SlicerSettings);
    const base = String(info.name || 'G-Code').replace(/\.(gcode|gco|g|bgcode|txt)$/i, '').slice(0, 50);
    const hasPrinter = r.printer.startGcode != null || r.printer.bedX != null;
    log('G-Code-Import „' + info.name + '“: ' + (r.slicer || 'unbekannt') + ', Werte: ' + (r.found.join(', ') || '–') + ', Drucker: ' + JSON.stringify(Object.keys(r.printer)));
    queue({ type: 'log', msg: 'G-Code-Import: ' + (r.slicer || 'unbekannt') + ', ' + r.found.length + ' Werte, Drucker ' + (hasPrinter ? (r.printer.name || base) : '–') });
    if (!r.found.length && !hasPrinter) { await ask({ title: T.importTitle, text: fmt(T.importNothing, { name: info.name }), ok: T.ok }); return; }
    const prName = String(r.printer.name || base).slice(0, 60);
    const lines = [fmt(T.importFound, { slicer: r.slicer || T.importUnknown, n: r.found.length })];
    lines.push(hasPrinter ? fmt(T.importPrinter, { name: prName, x: r.printer.bedX || '?', y: r.printer.bedY || '?', z: r.printer.bedZ || '?' }) : T.importNoPrinter);
    lines.push(fmt(T.importProfile, { name: base }));
    if (!(await ask({ title: T.importTitle, text: lines.join('\n'), ok: T.importApply }))) return;
    if (hasPrinter) {
      // Grundlage = aktueller Drucker; alles Erkannte ersetzt dessen Werte
      const extra = {};
      for (const k of ['bedX', 'bedY', 'bedZ', 'nozzle', 'filamentDiameter', 'flavor', 'centerZero', 'round']) if (r.printer[k] != null) extra[k] = r.printer[k];
      if (r.printer.startGcode != null) extra.startGcode = r.printer.startGcode;
      if (r.printer.endGcode != null) extra.endGcode = r.printer.endGcode;
      extra.note = fmt(T.importNote, { name: info.name, slicer: r.slicer || '' });
      state.gcode = null; recompute();
      const np = storePrinter(prName, extra);
      state.recent = [np.id].concat((state.recent || []).filter((x) => x !== np.id)).slice(0, 5);
      state.printer = np.id;
      state.machine = machineOf(np);
    }
    if (r.material && standard.materials[r.material]) state.material = r.material;
    Object.assign(state.values, r.values);
    const values = {};
    for (const it of paramItems()) values[it.key] = state.values[it.key];
    profiles.params[base] = { material: state.material, values };
    saveProfiles();
    changed(true, hasPrinter);
    toast(fmt(T.importDone, { name: base }));
  }
  // Reiter „Parameter“: Material + alle Druckeinstellungen
  function renderParams() {
    if (!standard || !state) return;
    const box = $('setPane');
    const keepScroll = box.scrollTop;
    box.innerHTML = '';
    box.appendChild(profileBar());
    secHead(box, 'material');
    const rowM = document.createElement('div'); rowM.className = 'setRow';
    const lm = document.createElement('span'); lm.className = 'lbl'; lm.textContent = T.l_material; rowM.appendChild(lm);
    const segs = document.createElement('span'); segs.className = 'segs'; segs.id = 'materials';
    for (const name of Object.keys(standard.materials)) {
      const b = document.createElement('button'); b.textContent = name; b.classList.toggle('on', name === state.material);
      b.addEventListener('click', () => selectMaterial(name));
      segs.appendChild(b);
    }
    rowM.appendChild(segs); box.appendChild(rowM);
    for (const S of SlicerSettings.SECTIONS) {
      if (S.id !== 'material') secHead(box, S.id);
      for (const item of S.items) box.appendChild(control(item, state.values, 'values'));
    }
    const warn = SlicerSettings.warnings(profile);
    for (const w of warn) { const p = document.createElement('p'); p.className = 'note warnNote'; p.textContent = '⚠︎ ' + T[w]; box.insertBefore(p, box.children[2]); }
    const rowR = document.createElement('div'); rowR.className = 'setRow';
    const reset = document.createElement('button'); reset.id = 'btnResetValues'; reset.textContent = T.resetValues;
    reset.addEventListener('click', () => { const keep = { recent: state.recent, ui: state.ui, gcode: state.gcode, machine: state.machine, net: state.net }; state = Object.assign(defaultState(state.printer), keep); changed(true); });
    rowR.appendChild(reset); box.appendChild(rowR);
    const note = document.createElement('p'); note.className = 'note'; note.id = 'setNote'; note.textContent = T.hintTest + ' ' + T.setNote; box.appendChild(note);
    box.scrollTop = keepScroll;
  }
  // Eine Zeile: Beschriftung + Regler/Auswahl/Schalter + Zahlenfeld
  function control(item, target, where) {
    const row = document.createElement('div'); row.className = 'setRow ctl'; row.dataset.key = item.key;
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = T['l_' + item.key] || item.key; row.appendChild(l);
    const v = target[item.key];
    const set = (nv, rerender) => {
      const c = SlicerSettings.clean(item, nv);
      if (c === null) { row.classList.add('bad'); return false; }
      row.classList.remove('bad');
      if (target[item.key] === c) return true;
      target[item.key] = c;
      changed(rerender, where === 'machine');
      return true;
    };
    if (item.type === 'num') {
      // ‹ Zahl ›: Pfeile = ein Schritt des Reglers (halten = wiederholen), antippen = eintippen
      const vc = window.ValueCtl.create({
        value: v, step: item.step, min: item.min, max: item.max, unit: item.unit, drag: false, // Ziehen störte beim Scrollen (Nutzer 2026-11-11)
        format: (x) => fmtValue(item, x),
        onInput: (x) => { set(x, false); },
        onCommit: (x) => ({ ok: set(x, false), value: target[item.key] }),
        onEnd: () => { if (!row.classList.contains('bad')) renderSettings(); },
        onError: (w, e) => logError(w, e),
      });
      row.appendChild(vc.el);
    } else if (item.type === 'toggle') {
      const segs = document.createElement('span'); segs.className = 'segs';
      for (const [val, key] of [[true, 'on'], [false, 'off']]) {
        const b = document.createElement('button'); b.textContent = T[key]; b.classList.toggle('on', !!v === val);
        b.addEventListener('click', () => set(val, true));
        segs.appendChild(b);
      }
      row.appendChild(segs);
    } else if (item.options.length <= 4) {
      const segs = document.createElement('span'); segs.className = 'segs';
      for (const o of item.options) {
        const b = document.createElement('button'); b.textContent = labelOf(item, o); b.classList.toggle('on', String(v) === String(o));
        b.addEventListener('click', () => set(o, true));
        segs.appendChild(b);
      }
      row.appendChild(segs);
    } else {
      const sel = document.createElement('select');
      for (const o of item.options) { const op = document.createElement('option'); op.value = String(o); op.textContent = labelOf(item, o); sel.appendChild(op); }
      sel.value = String(v);
      sel.addEventListener('change', () => set(sel.value, true));
      row.appendChild(sel);
    }
    return row;
  }
  // ---------- Druckerauswahl mit Suche ----------
  const groupOf = (p) => (/^eigen-/.test(p.id) ? 'own' : /^allgemein-/.test(p.id) ? 'general' : 'library');
  function printerLabel(p) { return (p.maker && !p.name.startsWith(p.maker) ? p.maker + ' · ' : '') + p.name; }
  function allPrinters() { return (standard ? standard.printers : []).concat(profiles.printers, library); }
  // Suche: alle Wörter müssen vorkommen (Hersteller, Modell, Kennung), ohne Groß/Klein, Bindestriche/Leerzeichen egal
  const norm = (t) => String(t).toLowerCase().replace(/[-_·]+/g, ' ');
  function searchPrinters(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const list = allPrinters();
    if (!words.length) return list;
    return list.filter((p) => { const hay = norm((p.maker || '') + ' ' + p.name + ' ' + p.id); const compact = hay.replace(/\s+/g, ''); return words.every((w) => hay.includes(w) || compact.includes(w)); });
  }
  function openPicker() {
    if (busy) return;
    $('pickDialog').classList.remove('hidden');
    $('printerSearch').value = '';
    renderPicker();
    $('printerResults').scrollTop = 0;
    setTimeout(() => $('printerSearch').focus(), 50);
  }
  function closePicker() { $('pickDialog').classList.add('hidden'); $('printerSearch').blur(); }
  function renderPicker() {
    const q = $('printerSearch').value.trim();
    const box = $('printerResults');
    box.innerHTML = '';
    const found = searchPrinters(q);
    const groups = [];
    if (!q) {
      const recent = (state.recent || []).map(printerById).filter(Boolean);
      if (recent.length) groups.push(['recent', recent]);
    }
    for (const g of ['own', 'general', 'library']) { const l = found.filter((p) => groupOf(p) === g); if (l.length) groups.push([g, l]); }
    for (const [g, list] of groups) {
      const h = document.createElement('div'); h.className = 'grp'; h.textContent = T['group_' + g] + (q ? ' (' + list.length + ')' : ''); box.appendChild(h);
      for (const p of list) {
        const b = document.createElement('button');
        b.dataset.id = p.id;
        b.classList.toggle('cur', p.id === state.printer);
        b.innerHTML = '<span></span><span class="pm"></span>';
        b.firstChild.textContent = printerLabel(p);
        b.lastChild.textContent = fmt(T.printerInfo, { flavor: flavorName(p.flavor), x: +(+p.bedX).toFixed(1), y: +(+p.bedY).toFixed(1), z: +(+p.bedZ).toFixed(1), round: p.round ? T.roundBed : '' });
        b.addEventListener('click', () => { closePicker(); selectPrinter(p.id); });
        box.appendChild(b);
      }
    }
    if (!groups.length) { const d = document.createElement('div'); d.className = 'none'; d.textContent = fmt(T.noPrinterFound, { q }); box.appendChild(d); }
  }
  function selectPrinter(id) {
    if (busy || !printerById(id)) return;
    const pr = printerById(id);
    state.recent = [id].concat((state.recent || []).filter((r) => r !== id)).slice(0, 5);
    state.printer = id;
    state.machine = machineOf(pr);
    state.gcode = null;
    Object.assign(state.values, suggestValues(pr), materialValues(pr, state.material));
    changed(true, true);
  }
  function selectMaterial(m) {
    if (busy) return;
    state.material = m;
    Object.assign(state.values, materialValues(printerById(state.printer), m));
    changed(true);
  }
  // Nach jeder Änderung: neu berechnen, speichern (verzögert), Vorschau als veraltet markieren
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => queue({ type: 'saveSettings', data: JSON.stringify(state) }), 800);
  }
  function changed(rerender, machineChanged) {
    recompute();
    renderPrinterLine();
    if (rerender) renderSettings();
    if (machineChanged && viewer) {
      // Anderes Bett: alte Vorschau passt nicht mehr (Lage/Koordinaten) → verwerfen, Modell neu auf das Bett legen (Kamera neu ausrichten)
      stopPlay();
      if (result) { result = null; renderResult(); updateButtons(); status(T.changed); }
      setViewerBed();
      // passt die Platte nicht mehr aufs neue Bett → neu anordnen
      if (layoutCheck().some((c) => c.outside)) arrangeAll();
      refreshPlate(true);
    }
    if (result && !result.stale) { result.stale = true; status(T.changed); }
    scheduleSave();
  }
  function setTab(which) {
    $('tabPrinter').classList.toggle('on', which === 'printer');
    $('tabParams').classList.toggle('on', which === 'params');
    $('tabObjects').classList.toggle('on', which === 'objects');
    $('printerPane').classList.toggle('hidden', which !== 'printer');
    $('setPane').classList.toggle('hidden', which !== 'params');
    $('objBox').classList.toggle('hidden', which !== 'objects');
    // nur links sichtbar wäre der Reiter unsichtbar → wie Studio auf „beides“ schalten
    if (viewModeSetting() === 'view') setPaneMode('both');
  }
  // Ansicht rechts: 3D | Schicht (2D von oben) | G-Code (nur lesen, Zeile zur Zeit markiert)
  let viewMode = '3d';
  function setViewMode(m) {
    viewMode = m;
    $('mode3d').classList.toggle('on', m === '3d');
    $('modeLayer').classList.toggle('on', m === 'layer');
    $('modeGcode').classList.toggle('on', m === 'gcode');
    $('layerCanvas').classList.toggle('hidden', m !== 'layer');
    $('gcodePane').classList.toggle('hidden', m !== 'gcode');
    $('legend').classList.toggle('hidden', !result || m === 'gcode');
    drawLayer();
    if (m === 'gcode') renderGcode(true);
  }

  // ---------- Ergebnis: Kennzahlen, Zeitachse, Vorschau ----------
  const COLORS = ['#ff4f1a', '#e0b36a', '#8fb8ff', '#5fd38d', '#a8a8a2', '#c792ea', '#c792ea', '#6d7f99', '#f4f4f0']; // Reihenfolge = SlicerCore TYPES
  const LEGEND = [[0, 'legendOuter'], [1, 'legendInner'], [2, 'legendSkin'], [3, 'legendFill'], [4, 'legendSkirt'], [5, 'legendSupport']];
  let cur = { seg: 0, layer: 0 }; // gezeigter Zeitpunkt: Bahnstücke [0, seg) gedruckt, Schicht layer
  function renderResult() {
    const has = !!result;
    $('stats').classList.toggle('hidden', !has);
    $('legend').classList.toggle('hidden', !has || viewMode === 'gcode');
    for (const id of ['layerSlider', 'timeSlider', 'btnPlay']) $(id).disabled = !has;
    if (!has) {
      if (viewer) viewer.clearToolpaths();
      $('timeInfo').textContent = ''; $('layerInfo').textContent = '';
      renderGcode(true); drawLayer();
      return;
    }
    const m = result.meta, tp = result.tp;
    $('stats').innerHTML = '';
    const st = [[T.statTime, SlicerCore.fmtTime(m.printTime)], [T.statFilament, (m.filamentMm / 1000).toFixed(2) + ' m'],
      [T.statLayers, String(tp.layerStart.length)], [T.statSize, result.size.map((v) => v.toFixed(0)).join('×')]];
    for (const [k, v] of st) { const d = document.createElement('div'); d.innerHTML = '<b></b><span></span>'; d.querySelector('b').textContent = v; d.querySelector('span').textContent = k; $('stats').appendChild(d); }
    $('legend').innerHTML = '';
    for (const [k, key] of LEGEND) {
      const s = document.createElement('span'); s.innerHTML = '<i></i>'; s.querySelector('i').style.background = COLORS[k]; s.appendChild(document.createTextNode(T[key])); $('legend').appendChild(s);
    }
    // Farben je Bahnstück für die 3D-Ansicht
    const col = new Float32Array(tp.count * 6);
    const rgb = COLORS.map((h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]);
    for (let i = 0; i < tp.count; i++) { const c = rgb[tp.type[i]]; col.set(c, i * 6); col.set(c, i * 6 + 3); }
    viewer.showToolpaths({ pos: tp.pos, col, count: tp.count });
    $('layerSlider').max = String(tp.layerStart.length - 1);
    setTime(tp.totalTime, 'end');
  }
  // Zeit (s) → gezeigter Fortschritt; from: 'time' | 'layer' | 'play' | 'end' (welcher Regler nicht zurückgesetzt wird)
  function setTime(t, from) {
    if (!result) return;
    const tp = result.tp;
    t = Math.max(0, Math.min(tp.totalTime, t));
    const seg = t >= tp.totalTime ? tp.count : SlicerCore.segmentAt(tp, t);
    const layer = SlicerCore.layerOfSegment(tp, seg);
    cur = { seg, layer, t };
    if (from !== 'time') $('timeSlider').value = String(Math.round((t / Math.max(1, tp.totalTime)) * 1000));
    if (from !== 'layer') $('layerSlider').value = String(layer);
    $('timeInfo').textContent = fmt(T.timeInfo, { t: SlicerCore.fmtClock(t), total: SlicerCore.fmtClock(tp.totalTime) });
    $('layerInfo').textContent = fmt(T.layer, { n: layer + 1, total: tp.layerStart.length, z: tp.layerZ[layer].toFixed(2) });
    viewer.setProgress(tp.layerStart[layer], seg);
    drawLayer();
    renderGcode(false);
  }
  function setLayer(i) {
    const tp = result.tp;
    // Ende der Schicht i = Beginn der nächsten (bzw. Druckende)
    const t = i + 1 < tp.layerStart.length ? tp.layerTime[i + 1] : tp.totalTime;
    setTime(t, 'layer');
  }
  // G-Code-Ausschnitt um die Zeile der aktuellen Bewegung (virtuell: nur ~300 Zeilen im DOM)
  let gcodeShown = null;
  function renderGcode(force) {
    const box = $('gcode');
    if (viewMode !== 'gcode') return;
    if (!result) {
      box.innerHTML = '<div class="hint"></div>';
      box.firstChild.textContent = T.gcodeHint;
      $('gcodeHead').textContent = '';
      gcodeShown = null;
      return;
    }
    const tp = result.tp, lines = result.lines;
    const line = cur.seg > 0 ? tp.line[cur.seg - 1] : tp.layerLine[0];
    $('gcodeHead').textContent = fmt(T.gcodeRange, { line: line + 1, total: lines.length });
    const from = Math.max(0, line - 60), to = Math.min(lines.length, line + 240);
    if (force || !gcodeShown || line < gcodeShown.from + 20 || line > gcodeShown.to - 60) {
      const frag = document.createDocumentFragment();
      for (let n = from; n < to; n++) {
        const t = lines[n];
        const d = document.createElement('div');
        d.dataset.n = n;
        const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = n + 1; d.appendChild(ln);
        if (t.startsWith(';')) { const c = document.createElement('span'); c.className = 'c'; c.textContent = t; d.appendChild(c); }
        else {
          const ci = t.indexOf(' ');
          const g = document.createElement('span'); g.className = 'g'; g.textContent = ci > 0 ? t.slice(0, ci) : t; d.appendChild(g);
          if (ci > 0) d.appendChild(document.createTextNode(t.slice(ci)));
        }
        frag.appendChild(d);
      }
      box.innerHTML = '';
      box.appendChild(frag);
      gcodeShown = { from, to };
    }
    const old = box.querySelector('.cur');
    if (old) old.classList.remove('cur');
    const el = box.children[line - gcodeShown.from];
    if (el) {
      el.classList.add('cur');
      box.scrollTop = el.offsetTop - box.clientHeight * 0.35;
    }
  }
  // Schicht von oben (2D): aktuelle Schicht bis zum Zeitpunkt hell, Schicht darunter blass
  function drawLayer() {
    const c = $('layerCanvas');
    if (viewMode !== 'layer' || !profile) return;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--bg0'); ctx.fillRect(0, 0, r.width, r.height);
    const bw = profile.bedX, bd = profile.bedY, pad = 24;
    const bx = profile.centerZero ? -bw / 2 : 0, by = profile.centerZero ? -bd / 2 : 0; // Delta-Drucker: Bettmitte = 0
    // Ausschnitt: Modell + Rand (kleine Modelle sonst winzig), höchstens das Bett
    let x0 = bx, y0 = by, x1 = bx + bw, y1 = by + bd;
    if (hasObjects()) {
      const cx = bx + bw / 2, cy = by + bd / 2;
      const ex = plate.objects.reduce((m, o) => [Math.min(m[0], o.x - o.size[0] / 2), Math.max(m[1], o.x + o.size[0] / 2), Math.min(m[2], o.y - o.size[1] / 2), Math.max(m[3], o.y + o.size[1] / 2)], [Infinity, -Infinity, Infinity, -Infinity]);
      x0 = Math.max(bx, cx + ex[0] - 12); x1 = Math.min(bx + bw, cx + ex[1] + 12); y0 = Math.max(by, cy + ex[2] - 12); y1 = Math.min(by + bd, cy + ex[3] + 12);
    }
    const s = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad - 30) / (y1 - y0));
    const ox = (r.width - (x1 - x0) * s) / 2 - x0 * s, oy = (r.height - (y1 - y0) * s) / 2 + y1 * s;
    const X = (x) => ox + x * s, Y = (y) => oy - y * s; // Y nach oben wie auf dem Druckbett
    ctx.fillStyle = css.getPropertyValue('--fill'); ctx.fillRect(X(x0), Y(y1), (x1 - x0) * s, (y1 - y0) * s);
    ctx.strokeStyle = css.getPropertyValue('--line'); ctx.lineWidth = 1;
    const step = s > 8 ? 5 : 10;
    for (let g = Math.ceil(x0 / step) * step; g <= x1; g += step) { ctx.beginPath(); ctx.moveTo(X(g), Y(y0)); ctx.lineTo(X(g), Y(y1)); ctx.stroke(); }
    for (let g = Math.ceil(y0 / step) * step; g <= y1; g += step) { ctx.beginPath(); ctx.moveTo(X(x0), Y(g)); ctx.lineTo(X(x1), Y(g)); ctx.stroke(); }
    if (!result) return;
    const tp = result.tp, L = cur.layer;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const lw = Math.max(1, (profile.lineWidth || 0.42) * s);
    function seg(a, b, color, alpha) {
      ctx.globalAlpha = alpha; ctx.lineWidth = lw;
      let last = -1;
      for (let i = a; i < b; i++) {
        const o = i * 6;
        const col = color || COLORS[tp.type[i]];
        if (col !== last) { if (last !== -1) ctx.stroke(); ctx.strokeStyle = col; ctx.beginPath(); last = col; }
        ctx.moveTo(X(tp.pos[o]), Y(tp.pos[o + 1])); ctx.lineTo(X(tp.pos[o + 3]), Y(tp.pos[o + 4]));
      }
      if (last !== -1) ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (L > 0) seg(tp.layerStart[L - 1], tp.layerStart[L], css.getPropertyValue('--muted'), 0.3);
    seg(tp.layerStart[L], cur.seg, null, 1);
    if (cur.seg > tp.layerStart[L]) {
      const o = (cur.seg - 1) * 6;
      ctx.fillStyle = css.getPropertyValue('--fg'); ctx.beginPath(); ctx.arc(X(tp.pos[o + 3]), Y(tp.pos[o + 4]), 4, 0, 2 * Math.PI); ctx.fill();
    }
  }

  // ---------- Abspielen: ganzer Druck in ~30 s ----------
  let playing = null;
  function startPlay() {
    if (!result) return;
    const tp = result.tp;
    if (cur.t >= tp.totalTime) setTime(0, 'play');
    const rate = tp.totalTime / 30; // Druck-Sekunden je echter Sekunde
    let last = performance.now();
    $('btnPlay').textContent = '❚❚';
    const tick = (now) => {
      if (!playing) return;
      const t = cur.t + ((now - last) / 1000) * rate;
      last = now;
      setTime(t, 'play');
      if (t >= tp.totalTime) { stopPlay(); return; }
      playing = requestAnimationFrame(tick);
    };
    playing = requestAnimationFrame(tick);
  }
  function stopPlay() { if (playing) cancelAnimationFrame(playing); playing = null; $('btnPlay').textContent = '▶'; }

  // ---------- Export ----------
  function openExport() {
    if (!result || !result.saved) return;
    $('dlgTitle').textContent = T.exportTitle;
    $('dlgText').textContent = fmt(T.exportText, { path: result.saved });
    $('btnSendPrinter').classList.toggle('hidden', !netOn()); // 10m
    if (netOn()) $('btnSendPrinter').textContent = fmt(T.netSendBtn, { name: T['net_' + state.net.type] });
    $('dialog').classList.remove('hidden');
  }
  function closeExport() { $('dialog').classList.add('hidden'); }

  let initOpts = {};
  function init(o) {
    initOpts = Object.assign({}, initOpts, o);
    T = window.SLICER_I18N[o.lang] || window.SLICER_I18N.de;
    themeSetting = o.theme || 'system';
    if (o.deviceDark != null) deviceDark = !!o.deviceDark;
    applyTheme();
    document.documentElement.lang = o.lang;
    $('titleText').textContent = T.appName;
    $('testBadge').textContent = fmt(T.testBadge, { v: o.version });
    $('listTitle').textContent = T.listTitle;
    $('emptyList').textContent = T.listEmpty;
    // Zurück wie Studio: Pfeil + Text (Text fällt auf schmalen Geräten weg)
    $('btnBack').innerHTML = '<span class="bkArrow" aria-hidden="true">‹</span><span class="bkText"></span>';
    $('btnBack').lastChild.textContent = T.back.replace(/^‹\s*/, '');
    $('btnBack').title = T.back.replace(/^‹\s*/, '');
    $('btnBack').setAttribute('aria-label', $('btnBack').title);
    $('btnSlice').textContent = T.slice;
    iconButton('btnAdd', ICON.add, T.addTitle, 'STL');
    $('askText').style.whiteSpace = 'pre-line';
    iconButton('btnSavePlate', ICON.disk, T.savePlateTitle);
    for (const id of ['modeEdit', 'modeBoth', 'modeView']) { $(id).title = T[id]; $(id).setAttribute('aria-label', T[id]); }
    $('btnRemoveObj').textContent = T.remove;
    $('addTitle').textContent = T.addTitle;
    $('btnAddFiles').textContent = T.fromFiles;
    $('btnAddClose').textContent = T.close;
    $('btnAskCancel').textContent = T.cancel;
    $('plateHead').textContent = T.platesTitle;
    iconButton('btnExport', ICON.save, T.exportGcode);
    $('btnShare').textContent = T.share;
    $('btnFiles').textContent = T.saveFiles;
    $('btnDlgCancel').textContent = T.cancel;
    iconButton('btnLog', ICON.log, T.log);
    $('navApp').innerHTML = '<b>ScriptSCAD</b> <span>Slicer</span>';
    $('tabPrinter').textContent = T.tabPrinter;
    $('tabParams').textContent = T.tabParams;
    $('tabObjects').textContent = T.tabObjects;
    $('btnImport').textContent = T.importGcode;
    iconButton('btnSettings', ICON.settings, T.settingsTitle, T.settingsTitle);
    $('mode3d').textContent = T.mode3d;
    $('modeLayer').textContent = T.modeLayer;
    $('modeGcode').textContent = T.modeGcode;
    $('pickTitle').textContent = T.pickTitle;
    $('btnPickClose').textContent = T.close;
    $('printerSearch').placeholder = T.searchPrinter;
    $('btnPlay').title = T.play;
    renderList();
    renderGcode(true);
    updateTitle();
    updateNavMode();
    placeStatus();
  }
  // ---------- 10d: Einstellungen (Sprache, Darstellung) – gemeinsam mit Studio (ScriptSCAD/settings.json) ----------
  function openSettings() {
    let d = $('setDialog');
    if (!d) { d = document.createElement('div'); d.id = 'setDialog'; d.className = 'hidden'; document.body.appendChild(d); d.addEventListener('click', (e) => { if (e.target === d) closeSettings(); }); }
    d.innerHTML = '<div id="setBox" role="dialog"><h3></h3><div class="setGroup" id="setLang"><span class="lbl"></span><span class="segs"></span></div>' +
      '<div class="setGroup" id="setTheme"><span class="lbl"></span><span class="segs"></span></div><p class="note"></p><div class="setGroup"><button id="btnAbout"></button></div><div class="foot"><button id="btnSetClose" class="primary"></button></div></div>';
    d.querySelector('h3').textContent = T.settingsTitle;
    d.querySelector('.note').textContent = T.settingsNote;
    const group = (id, label, opts, cur, pick) => {
      const g = d.querySelector('#' + id);
      g.querySelector('.lbl').textContent = label;
      for (const [val, text] of opts) {
        const b = document.createElement('button'); b.textContent = text; b.dataset.val = val; b.classList.toggle('on', val === cur);
        b.addEventListener('click', () => pick(val));
        g.querySelector('.segs').appendChild(b);
      }
    };
    group('setLang', T.setLanguage, [['', T.setAuto], ['de', 'Deutsch'], ['en', 'English']], initOpts.langSetting || '', (v) => changeCommon({ lang: v }));
    group('setTheme', T.setTheme, [['system', T.setAuto], ['light', T.setLight], ['dark', T.setDark]], themeSetting, (v) => changeCommon({ theme: v }));
    $('btnSetClose').textContent = T.close;
    $('btnSetClose').addEventListener('click', closeSettings);
    $('btnAbout').textContent = ScriptSCADAbout.text(initOpts.lang).open; // 10o: Über & Lizenzen (about.js)
    $('btnAbout').addEventListener('click', openAbout);
    d.classList.remove('hidden');
  }
  function openAbout() {
    const box = $('setBox'), lang = initOpts.lang;
    box.textContent = '';
    const h = document.createElement('h3'); h.textContent = ScriptSCADAbout.text(lang).title; box.appendChild(h);
    ScriptSCADAbout.render(box, lang, 'slicer', VERSION);
    const foot = document.createElement('div'); foot.className = 'foot';
    const back = document.createElement('button'); back.id = 'btnAboutBack'; back.textContent = '‹ ' + T.settingsTitle; back.addEventListener('click', openSettings);
    const close = document.createElement('button'); close.id = 'btnAboutClose'; close.className = 'primary'; close.textContent = T.close; close.addEventListener('click', closeSettings);
    foot.appendChild(back); foot.appendChild(close); box.appendChild(foot);
    box.scrollTop = 0;
  }
  function closeSettings() { if ($('setDialog')) $('setDialog').classList.add('hidden'); }
  function changeCommon(c) {
    queue(Object.assign({ type: 'commonSettings' }, c));
    if (c.theme) { themeSetting = c.theme; initOpts.theme = c.theme; applyTheme(); }
    if (c.lang != null) {
      const lang = c.lang || initOpts.sysLang || initOpts.lang;
      init(Object.assign({}, initOpts, { lang, langSetting: c.lang }));
      if (state) { renderParams(); renderPrinterPane(); renderObjects(); }
    }
    openSettings(); // Fenster mit neuen Texten/Auswahl neu aufbauen
  }
  // Standard + Bibliothek + gespeicherte Einstellungen (von slicer-main.js)
  function setStandard(text) { standard = JSON.parse(text); }
  function libraryReady() { library = JSON.parse(new TextDecoder().decode(takeFile('library'))).drucker; log('Druckerbibliothek: ' + library.length + ' Drucker'); }
  function setUserSettings(text) {
    let saved = null;
    try { saved = text ? JSON.parse(text) : null; } catch (e) { log('einstellungen.json ungültig: ' + e.message); }
    state = defaultState(saved && printerById(saved.printer) ? saved.printer : standard.printer);
    if (saved) {
      if (standard.materials[saved.material]) state.material = saved.material;
      if (Array.isArray(saved.recent)) state.recent = saved.recent.filter((id) => printerById(id)).slice(0, 5);
      if (saved.ui && typeof saved.ui === 'object') {
        state.ui = {};
        for (const k of ['splitWide', 'splitTall']) if (typeof saved.ui[k] === 'number' && saved.ui[k] >= 10 && saved.ui[k] <= 90) state.ui[k] = Math.round(saved.ui[k]);
        if (['edit', 'both', 'view'].includes(saved.ui.viewMode)) state.ui.viewMode = saved.ui.viewMode;
      }
      if (saved.gcode && typeof saved.gcode.start === 'string' && typeof saved.gcode.end === 'string') state.gcode = { start: saved.gcode.start, end: saved.gcode.end };
      if (saved.net && NET_TYPES.includes(saved.net.type)) state.net = { type: saved.net.type, url: String(saved.net.url || '').slice(0, 200) }; // 10m
      // nur gültige, bekannte Werte übernehmen
      for (const item of SlicerSettings.MACHINE) if (saved.machine && saved.machine[item.key] != null) { const c = SlicerSettings.clean(item, saved.machine[item.key]); if (c !== null) state.machine[item.key] = c; }
      for (const S of SlicerSettings.SECTIONS) for (const item of S.items) if (saved.values && saved.values[item.key] != null) { const c = SlicerSettings.clean(item, saved.values[item.key]); if (c !== null) state.values[item.key] = c; }
    }
    recompute();
    renderPrinterLine();
    renderSettings();
    if (viewer) setViewerBed();
    applyLayout();
  }
  function setProfiles(text) {
    let d = null;
    try { d = text ? JSON.parse(text) : null; } catch (e) { log('profile.json ungültig: ' + e.message); }
    profiles = { params: {}, printers: [] };
    if (d && d.params && typeof d.params === 'object') for (const [n, pf] of Object.entries(d.params)) if (pf && typeof pf.values === 'object') profiles.params[n] = { material: String(pf.material || ''), values: pf.values };
    if (d && Array.isArray(d.printers)) profiles.printers = d.printers.filter((p) => p && typeof p.id === 'string' && /^eigen-u-/.test(p.id) && p.name && p.bedX > 0 && p.bedY > 0 && p.bedZ > 0);
  }
  function setModels(list) { models = list; renderList(); if (!$('addDialog').classList.contains('hidden')) openAdd(); }
  function setPlates(list) { plates = list; renderList(); }

  $('btnBack').addEventListener('click', () => { if (busy) return; stopPlay(); showScreen('list'); });
  $('btnSlice').addEventListener('click', () => { if (busy && cancelSlice) cancelSlice(); else slice(); });
  $('btnExport').addEventListener('click', openExport);
  $('btnShare').addEventListener('click', () => { closeExport(); queue({ type: 'share' }); });
  $('btnFiles').addEventListener('click', () => { closeExport(); queue({ type: 'saveToFiles' }); });
  $('btnSendPrinter').addEventListener('click', sendToPrinter);
  $('btnDlgCancel').addEventListener('click', closeExport);
  const logPanel = LogPanel({ button: $('btnLog') }); // 9i.2: mit Trennbalken (Höhe ziehen)
  $('btnLog').addEventListener('click', () => logPanel.toggle());
  initSplitter();
  for (const [id, m] of [['modeEdit', 'edit'], ['modeBoth', 'both'], ['modeView', 'view']]) $(id).addEventListener('click', () => setPaneMode(m));
  $('tabPrinter').addEventListener('click', () => setTab('printer'));
  $('tabParams').addEventListener('click', () => setTab('params'));
  $('tabObjects').addEventListener('click', () => setTab('objects'));
  $('mode3d').addEventListener('click', () => setViewMode('3d'));
  $('modeLayer').addEventListener('click', () => setViewMode('layer'));
  $('modeGcode').addEventListener('click', () => setViewMode('gcode'));
  $('btnPickClose').addEventListener('click', closePicker);
  $('pickDialog').addEventListener('click', (e) => { if (e.target === $('pickDialog')) closePicker(); });
  $('printerSearch').addEventListener('input', () => renderPicker());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pickDialog').classList.contains('hidden')) { e.preventDefault(); closePicker(); } });
  $('printerSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = $('printerResults').querySelector('button'); if (first && $('printerSearch').value.trim()) first.click(); }
  });
  const showPaths = () => { if (selectedId != null) selectObject(null); else if (viewer) viewer.setPathsVisible(true); };
  $('layerSlider').addEventListener('input', (e) => { stopPlay(); showPaths(); setLayer(+e.target.value); });
  $('timeSlider').addEventListener('input', (e) => { stopPlay(); showPaths(); setTime((+e.target.value / 1000) * result.tp.totalTime, 'time'); });
  $('btnPlay').addEventListener('click', () => { showPaths(); playing ? stopPlay() : startPlay(); });
  $('btnImport').addEventListener('click', () => { if (!busy) queue({ type: 'importGcode' }); });
  $('btnSettings').addEventListener('click', openSettings);
  // Tastenkürzel wie Studio (Hardware-Tastatur): ⌘1/2/3 Reiter, ⌘↩ Slicen, ⌘Z / ⇧⌘Z Rückgängig/Wiederholen (außerhalb von Eingabefeldern)
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !inProject()) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    const dialogOpen = ['askDialog', 'addDialog', 'pickDialog', 'dialog', 'setDialog'].some((id) => $(id) && !$(id).classList.contains('hidden'));
    if (dialogOpen) return;
    const k = e.key.toLowerCase();
    if (k === '1' || k === '2' || k === '3') { e.preventDefault(); setTab(['printer', 'params', 'objects'][+k - 1]); }
    else if (k === 'enter') { e.preventDefault(); if (!busy) slice(); }
    else if (k === 'z' && !inField) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  });
  $('btnAdd').addEventListener('click', openAdd);
  $('btnAddFiles').addEventListener('click', () => { closeAdd(); queue({ type: 'pickFiles' }); });
  $('btnAddClose').addEventListener('click', closeAdd);
  $('addDialog').addEventListener('click', (e) => { if (e.target === $('addDialog')) closeAdd(); });
  $('btnSavePlate').addEventListener('click', savePlate);
  $('btnRemoveObj').addEventListener('click', removeSelected);
  $('btnAskOk').addEventListener('click', () => askDone(true));
  $('btnAskCancel').addEventListener('click', () => askDone(false));
  $('btnAskAlt').addEventListener('click', askAlt);
  $('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askDone(true); } });
  window.addEventListener('resize', () => drawLayer());
  if (darkQuery) {
    const onSys = () => { if (themeSetting === 'system') applyTheme(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSys); else if (darkQuery.addListener) darkQuery.addListener(onSys);
  }

  window.App = {
    version: () => VERSION,
    init: (o) => init(typeof o === 'string' ? JSON.parse(o) : o),
    ready: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(JSON.stringify({ w: innerWidth, h: innerHeight }))))),
    setModels: (s) => setModels(JSON.parse(s)),
    setStandard, libraryReady, setUserSettings, setProfiles,
    setEngineSource: (t) => { engineSrc = String(t || ''); },
    gcodeImport: (s2) => { gcodeImport(JSON.parse(s2)).catch((e) => { logError('gcodeImport', e); status(fmt(T.error, { msg: e.message }), true); }); },
    _noWorker: () => { killWorker(); workerOk = false; return true; }, // nur Container-Tests: Slicen in der Seite erzwingen
    fileBegin, fileAdd,
    engineFinish,
    modelLoaded: (s) => { let info = {}; try { info = JSON.parse(s); } catch (e) { /* unten */ } modelLoaded(info).catch((e) => { logError('modelLoaded', e); modelFailed({ key: info.key, name: info.name || '', msg: e.message, counted: true }); }); },
    modelFailed: (s) => modelFailed(JSON.parse(s)),
    addModel: (src) => { if (hasObjects() || plate.name || inProject()) addModel(src); else newPlate(src); },
    setPlates: (s) => setPlates(JSON.parse(s)),
    netKeyState: (b) => { netKeySaved = !!b; },
    netResult: (s) => netResult(JSON.parse(s)),
    // 9i: aus Studio gestartet → Platte des Projekts laden bzw. neue Platte mit dessen STL
    openStart: (s) => { const o = JSON.parse(s); const p = o.plate && plates.find((x) => x.id === o.plate); if (p) loadPlate(p); else if (o.src) newPlate(o.src); },
    plateData: (s) => { try { plateData(JSON.parse(s)); } catch (e) { logError('plateData', e); status(fmt(T.error, { msg: e.message }), true); } },
    plateSaved: (s) => plateSaved(JSON.parse(s)),
    gcodeChunk,
    gcodeSaved: (s) => gcodeSaved(JSON.parse(s)),
    poll,
    status, toast, log,
    getLog: () => $('log').textContent,
    _simSafeTop: (px) => { document.documentElement.style.setProperty('--safeTop', px + 'px'); updateNavMode(); return document.body.classList.contains('navMode'); }, // nur Container-Tests
    _plate: () => ({ name: plate.name, selected: selectedId, pending, pid: plate.pid, undo: undoStack.length, redo: redoStack.length, objects: plate.objects.map((o) => ({ id: o.id, name: o.name, src: o.src, x: o.x, y: o.y, rot: o.rot, scale: o.scale, pre: o.pre, tris: o.tri.length / 9, size: o.size.map((v) => +v.toFixed(2)) })), check: layoutCheck(),
      screen: (id) => viewer && viewer.screenPos(id), pathsVisible: viewer ? viewer.pathsVisible() : null }),
    _state: () => ({ model: hasObjects() ? plateTitle() : null, result: result && { layers: result.tp.layerStart.length, segments: result.tp.count, meta: result.meta, saved: result.saved, worker: result.worker }, worker: workerOk, profiles: JSON.parse(JSON.stringify(profiles)), busy, material, cur, playing: !!playing, stale: !!(result && result.stale), state: JSON.parse(JSON.stringify(state)), profile: profile && { bedX: profile.bedX, centerZero: profile.centerZero, name: profile.name } }), // für Tests
  };
})();
