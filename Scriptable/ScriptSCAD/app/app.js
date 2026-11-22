// Oberfläche von ScriptSCAD Studio (läuft in der WebView).
// Gesteuert von main.js (Scriptable). Regeln aus Schritt 1:
//  - Scriptable ruft nur Funktionen auf, die SOFORT einfache Werte liefern; Ergebnisse über completion(Text).
//  - Aktionen der Seite (Tippen auf Buttons) landen in einer Warteschlange, die Scriptable per App.poll() abholt.
//  - Dateien liest/schreibt nur Scriptable. Die Seite rendert mit OpenSCAD (WASM) und zeigt das Modell.
(function () {
  'use strict';
  const APP_VERSION = '10o.2'; // muss zu VERSION in main.js passen
  const SAVE_DELAY_MS = 2000; // automatisch speichern, so lange nach der letzten Änderung
  const SLOW_RENDER_MS = 500; // länger → Regler rendern nur noch beim Loslassen
  const FAST_RENDER_MS = 250; // wieder so schnell → wieder live
  let T = window.I18N.de; // Sprache (8b): wird mit setLang umgeschaltet
  let lang = 'de';
  const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => (v && k in v ? v[k] : ''));
  const $ = (id) => document.getElementById(id);
  const tPage = performance.now();

  const queue = []; // Aktionen für Scriptable (bleiben, bis Scriptable sie per poll(ack) bestätigt, 7f.2)
  let nextActionId = 1;
  const send = (action) => queue.push(Object.assign({ _id: nextActionId++ }, action));

  // ---------- Protokoll & Meldungen ----------
  function log(msg) {
    const line = '[' + ((performance.now() - tPage) / 1000).toFixed(2) + ' s] ' + msg;
    const el = $('log');
    el.textContent += line + '\n';
    if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000);
  }
  function logError(where, e) {
    const m = (e && e.message) || String(e);
    log('FEHLER (' + where + '): ' + m);
    send({ type: 'log', text: 'Seite, ' + where + ': ' + m + (e && e.stack ? ' | ' + String(e.stack).split('\n')[0] : '') });
  }
  function status(msg, isError) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', !!isError);
  }
  // Fortschrittsbalken unter der Kopfzeile; bei 100 % kurz voll zeigen, dann ausblenden
  function progress(frac) {
    const b = $('bar');
    clearTimeout(progress._t);
    b.style.opacity = '1';
    b.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (frac >= 1) progress._t = setTimeout(() => { b.style.opacity = '0'; progress._t = setTimeout(() => { b.style.width = '0'; }, 300); }, 300);
  }
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3500);
  }
  // Fehler aus file://-Skripten meldet WebKit nur als „Script error.“ → zusätzlich try/catch an allen Einstiegspunkten
  window.addEventListener('error', (e) => {
    if (/ResizeObserver loop/.test(e.message || '')) return;
    logError('window.onerror', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => logError('Promise', e.reason));
  const safe = (where, fn) => function () {
    try {
      const r = fn.apply(this, arguments);
      if (r && typeof r.catch === 'function') r.catch((e) => logError(where, e));
    } catch (e) { logError(where, e); }
  };

  // ---------- Symbole (Linien-Symbole, Farbe = Textfarbe) ----------
  const { svg, iconButton, contentRect, safeTop } = UICommon; // 10b: gemeinsam mit dem Slicer (ui-common.js)
  const ICON = {
    undo: svg('<path d="M9 4 4 9l5 5M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    redo: svg('<path d="m15 4 5 5-5 5M20 9H9a5 5 0 0 0 0 10h3"/>'),
    history: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    stl: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'),
    // 9i: Düse über Schichtlinien (wie das Slicer-Symbol) = im Slicer öffnen
    slicer: svg('<path d="M8.5 3.5h7v4l-2 3h-3l-2-3Z M12 10.5v2.5"/><path d="M4 16h16M6 19.5h12"/>'),
    log: svg('<path d="M7 4h7l4 4v12H7Z M14 4v4h4 M9.5 12h6M9.5 15.5h6"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/><circle cx="12" cy="12" r="7"/>'),
    sketch: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" opacity=".45"/><path d="m14.5 6.5 3 3L10 17H7v-3Z"/>'),
    photo: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>'),
    // Datei-Upload: Blatt mit Pfeil nach oben; Dateien-Kachel: Blatt mit Ecke
    upload: svg('<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z"/><path d="M14 3.5V8h4.5"/><path d="M12 17.5v-6M9.5 14l2.5-2.5 2.5 2.5"/>'),
    file: svg('<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z"/><path d="M14 3.5V8h4.5"/>'),
    // Bild mit Diskette (Vorlage des Nutzers): Ansicht als Bild in Fotos sichern
    toPhotos: svg('<path d="M12.5 16H4.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v5.5"/><circle cx="7" cy="7.6" r="1.4"/><path d="M3 14.5l4-4 3 3M8.6 11.9l3.4-3.4 3.2 3.2"/><path d="M13 13.5h6l2.5 2.5v5.5a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5Z"/><path d="M15 13.5V16h3.6v-2.5M15 22v-3h4.4v3"/>'),
    cube: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z M4 7.5 12 12l8-4.5 M12 12v9"/>'),
    // Senden an den Kurzbefehl: Pfeil nach oben über gestapelten Ebenen (Mischung aus „Hochladen“ und Kurzbefehle-Ebenen)
    send: svg('<path d="M12 13V3.5M8 7.5l4-4 4 4"/><path d="M6.5 11.5 3.5 13.2 12 18l8.5-4.8-3-1.7"/><path d="M3.5 16.8 12 21.6l8.5-4.8" opacity=".55"/>'),
    // Ganzen Code kopieren: zwei Blätter; einfügen: Klemmbrett mit Pfeil
    copy: svg('<rect x="8.5" y="8.5" width="11" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>'),
    paste: svg('<path d="M9 4.5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="3" rx="1"/><path d="M12 9.5v7M9 13.5l3 3 3-3"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    // 8c: Projektliste (Umbenennen = Stift, Löschen = Papierkorb)
    pencil: svg('<path d="M15.5 5.5l3 3L9 18H6v-3Z M13.5 7.5l3 3"/>'),
    trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>'),
    cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    code: svg('<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>'),
    compare: svg('<path d="M12 3.5v17"/><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M6.5 15l3-3" opacity=".6"/>'),
    // 10i: Blatt mit Würfel und Plus = Teil (STL) ins Projekt holen
    part: svg('<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4"/><path d="M14 3.5V8h4.5v3"/><path d="M17.5 13.5 21 15.5v4l-3.5 2-3.5-2v-4Z"/><path d="M9 11h4M9 14.5h2.5" opacity=".6"/>'),
    // 10g: Würfel mit Schnittebene
    section: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" opacity=".5"/><path d="M3 13.5 12 9l9 4.5-9 4.5Z"/>'),
  };
  // 8c: Würfel aus dem Logo „Code wird Form“ (Orange, drei Flächen) – Kachel in der Projektliste
  const BRAND_CUBE = '<svg viewBox="30 28 40 44" aria-hidden="true"><polygon points="50,30 68,40.5 50,51 32,40.5" fill="#FF7A4D"/><polygon points="32,40.5 50,51 50,71 32,60.5" fill="#D93A0B"/><polygon points="50,51 68,40.5 68,60.5 50,71" fill="#FF4F1A"/></svg>';
  // KI-Agenten: eigene Symbole (keine Original-Logos), Farben/Formen nur zur Wiedererkennung
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => '<line x1="16" y1="16" x2="' + (16 + 10.5 * Math.cos((a * Math.PI) / 180)).toFixed(1) + '" y2="' + (16 + 10.5 * Math.sin((a * Math.PI) / 180)).toFixed(1) + '"/>').join('');
  const rainbow = (id) => '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9f0a"/><stop offset=".35" stop-color="#ff375f"/><stop offset=".7" stop-color="#bf5af2"/><stop offset="1" stop-color="#0a84ff"/></linearGradient></defs>';
  const AGENT_ICON = {
    'apple-cloud': '<svg viewBox="0 0 32 32" aria-hidden="true">' + rainbow('agA') + '<path d="M9 24h14.5a5.5 5.5 0 0 0 .7-10.95A7.5 7.5 0 0 0 9.9 12.6 5.7 5.7 0 0 0 9 24Z" fill="none" stroke="url(#agA)" stroke-width="2.2"/><path d="M16 13.2l1.2 2.7 2.7 1.2-2.7 1.2L16 21l-1.2-2.7-2.7-1.2 2.7-1.2Z" fill="url(#agA)"/></svg>',
    'claude-app': '<svg viewBox="0 0 32 32" aria-hidden="true"><g stroke="#d97757" stroke-width="3.2" stroke-linecap="round">' + rays + '</g><circle cx="16" cy="16" r="3.2" fill="#d97757"/></svg>',
    'apple-chatgpt': '<svg viewBox="0 0 32 32" aria-hidden="true">' + rainbow('agB') + '<path d="M12 5l1.8 4.2L18 11l-4.2 1.8L12 17l-1.8-4.2L6 11l4.2-1.8Z" fill="url(#agB)"/><circle cx="21.5" cy="21.5" r="7" fill="#10a37f"/><path d="M18.4 21.5h.01M21.5 21.5h.01M24.6 21.5h.01" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
    'chatgpt-app': '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 9.5A4.5 4.5 0 0 1 10.5 5h11A4.5 4.5 0 0 1 26 9.5v8a4.5 4.5 0 0 1-4.5 4.5H14l-5.5 4.5V22A4.5 4.5 0 0 1 6 17.5Z" fill="#10a37f"/><path d="M11.5 13.5h.01M16 13.5h.01M20.5 13.5h.01" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/></svg>',
    test: '<svg viewBox="0 0 32 32" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5h6M14 5v8l-6.5 10.5A2.3 2.3 0 0 0 9.5 27h13a2.3 2.3 0 0 0 2-3.5L18 13V5"/><path d="M10.5 19.5h11" opacity=".6"/></svg>',
  };


  // Kopfzeile: Werkzeuge scrollen seitlich, wenn das Fenster zu schmal ist (iPhone hochkant).
  // Ränder blenden weich aus, solange in diese Richtung noch Knöpfe verborgen sind (Klassen fadeL / fadeR).
  function updateToolFade() {
    const t = document.querySelector('header .tools');
    if (!t) return;
    const max = t.scrollWidth - t.clientWidth;
    t.classList.toggle('fadeL', max > 1 && t.scrollLeft > 1);
    t.classList.toggle('fadeR', max > 1 && t.scrollLeft < max - 1);
  }
  function initToolScroll() {
    const t = document.querySelector('header .tools');
    t.addEventListener('scroll', updateToolFade, { passive: true });
    window.addEventListener('resize', updateToolFade);
    if (window.ResizeObserver) new ResizeObserver(updateToolFade).observe(t);
    updateToolFade();
  }

  // ---------- 8c: Titel in der Scriptable-Leiste ----------
  // Scriptable zeigt die WebView unter einer durchsichtigen Leiste („Close“ links, Teilen rechts). Liegt die Seite darunter, meldet
  // iOS oben einen großen Sicherheitsabstand (iPhone ≈ 100 px, iPad ≈ 74 px). Dann zeigen wir Logo, App- und Projektname in dieser
  // Leiste (nur Anzeige – Antippen erreicht Scriptable, nicht die Seite) und die Kopfzeile enthält nur noch Knöpfe.
  // Nur im Hochformat (Wunsch Nutzer); im Querformat bleibt der Titel in der Kopfzeile. --safeTop = Ersatzwert für Container-Tests.
  let navMode = null;
  let navLogged = '';
  function updateNavMode() {
    const top = safeTop();
    const portrait = window.innerHeight > window.innerWidth;
    const on = portrait && top >= 60;
    const inList = $('screenProject').classList.contains('hidden');
    const key = top + '|' + portrait;
    if (key !== navLogged) { navLogged = key; log('Leiste oben: Abstand ' + top + ' px, ' + (portrait ? 'hochkant' : 'quer') + ' → Titel ' + (on ? 'in der Scriptable-Leiste' : 'in der Kopfzeile')); }
    navMode = on;
    document.body.classList.toggle('navMode', on);
    document.body.classList.toggle('listScreen', inList);
    $('navTitle').classList.toggle('hidden', !on);
    // Projektliste in der Scriptable-Leiste: Kopfzeile entfällt, Protokoll-Knopf wandert zu „Einstellungen“/„Neues Projekt“
    const lb = $('btnLog');
    const wantList = on && inList;
    const actions = document.querySelector('.listActions');
    if (wantList && lb.parentNode !== actions) actions.insertBefore(lb, actions.firstChild);
    if (!wantList && lb.parentNode !== document.querySelector('header')) document.querySelector('header').appendChild(lb);
    updateToolFade();
  }

  // ---------- Sprache (8b): Deutsch/Englisch, ohne Neustart umschaltbar ----------
  function setLang(l, rebuild) {
    l = window.I18N[l] ? l : 'de';
    const changed = l !== lang;
    lang = l;
    T = window.I18N[l];
    document.documentElement.lang = l;
    if (window.SCADObjects) window.SCADObjects.setLabels(T.objLabels);
    if (!changed || !rebuild) return changed;
    applyTexts();
    renderList();
    if (current) {
      const prompt = $('aiPrompt') ? $('aiPrompt').value : '';
      buildAiPane();
      if ($('aiPrompt')) $('aiPrompt').value = prompt;
      renderAiHistory();
      if (lastMsgs) showConsole(lastMsgs);
      paramSig = null;
      objSig = null;
      refreshParams(true);
      updateDirty();
    }
    if (!$('panel').classList.contains('hidden') && $('setLang')) showSettings();
    return true;
  }

  // ---------- Feste Texte ----------
  function applyTexts() {
    $('titleText').textContent = T.appName;
    $('navApp').firstChild.textContent = T.brandMain;
    $('navApp').lastChild.textContent = T.brandSub;
    // Zurück: Pfeil + Text; auf dem iPhone im Hochformat blendet style.css den Text aus (nur ‹)
    $('btnBack').innerHTML = '<span class="bkArrow" aria-hidden="true">‹</span><span class="bkText"></span>';
    $('btnBack').lastChild.textContent = T.back.replace(/^‹\s*/, '');
    $('btnBack').title = T.back.replace(/^‹\s*/, '');
    $('btnBack').setAttribute('aria-label', $('btnBack').title);
    iconButton('btnLog', ICON.log, T.showLog);
    $('btnRender').textContent = T.render;
    iconButton('btnPart', ICON.part, T.partTitle);
    iconButton('btnSection', ICON.section, T.sectionTitle);
    iconButton('btnViewPhoto', ICON.toPhotos, T.aiToPhotos);
    iconButton('btnStl', ICON.stl, T.exportStlTitle, T.exportStl);
    iconButton('btnSlicer', ICON.slicer, T.openSlicerTitle);
    iconButton('btnCopy', ICON.copy, T.copyCode);
    iconButton('btnPaste', ICON.paste, T.pasteCode);
    iconButton('btnUndo', ICON.undo, T.undo);
    iconButton('btnRedo', ICON.redo, T.redo);
    for (const [id, key] of [['modeEdit', 'modeEdit'], ['modeBoth', 'modeBoth'], ['modeView', 'modeView'], ['splitter', 'splitter']]) {
      $(id).title = T[key];
      $(id).setAttribute('aria-label', T[key]);
    }
    $('tabCode').textContent = T.tabCode;
    $('tabParams').textContent = T.tabParams;
    $('tabAi').textContent = T.tabAi;
    iconButton('btnHistory', ICON.history, T.history);
    iconButton('btnSettings', ICON.settings, T.settings, T.settings);
    $('panelClose').textContent = T.close;
    $('listTitle').textContent = T.projectsTitle;
    $('btnNew').textContent = T.newProject;
    $('emptyList').textContent = T.noProjects;
    $('viewHelp').textContent = T.viewHelp;
    $('btnRepair').textContent = T.aiRepair;
    $('aiHistTitle').textContent = T.aiHistoryTitle;
  }

  // ---------- Dialog ----------
  // opts: { title, text, input (Vorgabe-Text, optional), buttons: [{ label, value, cls }] }
  // Ohne buttons: „Abbrechen“ + okText. Ergebnis: value des Buttons (OK mit Eingabe → eingegebener Text), Abbrechen → null.
  let dlgResolve = null;
  let dlgHasInput = false;
  function dialog(opts) {
    return new Promise((resolve) => {
      dlgResolve = resolve;
      $('dlgTitle').textContent = opts.title;
      $('dlgText').textContent = opts.text || '';
      $('dlgError').textContent = '';
      dlgHasInput = typeof opts.input === 'string';
      $('dlgInput').classList.toggle('hidden', !dlgHasInput);
      $('dlgInput').value = dlgHasInput ? opts.input : '';
      const buttons = opts.buttons || [
        ...(opts.noCancel ? [] : [{ id: 'dlgCancel', label: T.cancel, value: null }]),
        { id: 'dlgOk', label: opts.okText || T.ok, value: true, cls: opts.danger ? 'dangerFill' : 'primary' },
      ];
      const box = $('dlgButtons');
      box.textContent = '';
      buttons.forEach((b, i) => {
        const el = document.createElement('button');
        el.textContent = b.label;
        el.className = b.cls || '';
        el.id = b.id || 'dlgBtn' + i;
        el.addEventListener('click', () => dialogPress(b.value));
        box.appendChild(el);
      });
      $('dialog').classList.remove('hidden');
      if (dlgHasInput) setTimeout(() => { $('dlgInput').focus(); $('dlgInput').select(); }, 50);
    });
  }
  function closeDialog(value) {
    $('dlgInput').blur();
    $('dialog').classList.add('hidden');
    const r = dlgResolve;
    dlgResolve = null;
    if (r) r(value);
  }
  function dialogPress(value) {
    if (dlgHasInput && value === true) {
      const name = $('dlgInput').value.trim();
      if (!name) { $('dlgError').textContent = T.nameEmpty; return; }
      closeDialog(name);
    } else closeDialog(value);
  }

  // ---------- Projektliste ----------
  let projects = [];
  let current = null; // { id, name, code }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(T.dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function renderList() {
    const ul = $('projectList');
    ul.textContent = '';
    $('emptyList').classList.toggle('hidden', projects.length > 0);
    for (const p of projects) {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      const th = el('span', 'thumb');
      th.innerHTML = BRAND_CUBE;
      li.appendChild(th);
      const open = document.createElement('button');
      open.className = 'open';
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = p.name;
      const d = document.createElement('span');
      d.className = 'date';
      d.textContent = p.kind === 'test' ? T.testCubeSub : fmt(T.modified, { date: formatDate(p.modified) }); // 10n: wie im Slicer
      open.append(n, d);
      open.addEventListener('click', safe('öffnen', () => send({ type: 'open', id: p.id })));
      li.appendChild(open);
      // 8c: Aktionen als Symbol + Text; im schmalen Fenster (iPhone) nur das Symbol (style.css), alle in einer Zeile neben dem Namen
      const acts = el('span', 'acts');
      li.appendChild(acts);
      const mk = (cls, text, fn) => {
        const b = document.createElement('button');
        b.className = cls + ' tb';
        b.innerHTML = ICON[{ rename: 'pencil', duplicate: 'copy' }[cls] || 'trash'] + '<span></span>';
        b.lastChild.textContent = text;
        b.title = text;
        b.setAttribute('aria-label', text);
        b.addEventListener('click', safe(cls, fn));
        acts.appendChild(b);
      };
      mk('rename', T.rename, async () => {
        const name = await dialog({ title: T.renameTitle, input: p.name, okText: T.save });
        if (name && name !== p.name) send({ type: 'rename', id: p.id, name });
      });
      mk('duplicate', T.duplicate, () => send({ type: 'duplicate', id: p.id }));
      if (p.kind !== 'test') mk('delete danger', T.delete, async () => {
        const ok = await dialog({ title: T.deleteTitle, text: fmt(T.deleteText, { name: p.name }), okText: T.delete, danger: true });
        if (ok) send({ type: 'delete', id: p.id });
      });
      ul.appendChild(li);
    }
  }

  function showScreen(which) {
    const isList = which === 'list';
    $('screenList').classList.toggle('hidden', !isList);
    $('screenProject').classList.toggle('hidden', isList);
    $('btnBack').classList.toggle('hidden', isList);
    document.querySelectorAll('.projOnly').forEach((el) => el.classList.toggle('hidden', isList));
    $('titleText').textContent = isList ? T.appName : current.name;
    $('navName').textContent = isList ? '' : current.name;
    $('navTitle').classList.toggle('proj', !isList);
    if (isList) $('dirty').classList.add('hidden');
    updateNavMode();
    placeStatus();
    if (!isList && viewer) setTimeout(() => viewer.resize(), 50);
  }

  // ---------- Editor & Speichern ----------
  let editor = null;
  let savedCode = null; // zuletzt gespeicherter Stand
  let saveTimer = null;
  let saveSeq = 0;
  const pendingSaves = {}; // seq → Code, bis Scriptable bestätigt

  function updateDirty() {
    const dirty = current && editor.getCode() !== savedCode;
    $('dirty').classList.toggle('hidden', !current);
    $('dirty').textContent = dirty ? T.unsaved : T.saved;
    $('navDirty').textContent = !current ? '' : dirty ? '●' : '✓';
    $('navDirty').classList.toggle('unsaved', !!dirty);
    $('navDirty').title = dirty ? T.unsaved : T.saved;
    $('btnUndo').disabled = !editor.canUndo();
    $('btnRedo').disabled = !editor.canRedo();
  }
  function onEdit() {
    updateDirty();
    // Code wurde geändert, während ein KI-Vorschlag angezeigt wird → Vorschau beenden (Vorschlag verworfen)
    if (aiPreview && !applyingParam) { endPreview(false, true); toast(T.aiPreviewEnded); }
    if (!applyingParam) refreshParams(false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }
  let lastSnapCode = null; // zuletzt als Version gesicherter Code
  // snapshot = true: zusätzlich eine Version in history/ sichern (beim Rendern, Verlassen, vor Wiederherstellen)
  function saveNow(snapshot) {
    clearTimeout(saveTimer);
    if (!current) return;
    const code = editor.getCode();
    const snap = !!snapshot && code !== lastSnapCode;
    if (code === savedCode && !snap) return;
    current.code = code;
    if (snap) lastSnapCode = code;
    const seq = ++saveSeq;
    pendingSaves[seq] = code;
    send({ type: 'save', id: current.id, code, seq, snapshot: snap });
  }

  // ---------- Meldungen von OpenSCAD (unter dem Editor) ----------
  function parseOutput(lines) {
    const msgs = [];
    let libDeprecated = 0;
    for (const raw of lines) {
      const l = String(raw);
      const m = /^(ERROR|WARNING|ECHO|TRACE|DEPRECATED):\s*(.*)$/.exec(l);
      if (!m) continue;
      // Meldung aus einer Bibliotheksdatei (7g): Zeilennummer gehört nicht zum eigenen Code; veraltete Schreibweisen
      // in der Bibliothek selbst (z. B. NopSCADlib) kann der Nutzer nicht ändern → nur zählen
      const inLib = /in file \/?(BOSL2|MCAD|NopSCADlib)\//.test(m[2]);
      if (inLib && m[1] === 'DEPRECATED') { libDeprecated++; continue; }
      const kind = m[1] === 'ERROR' ? 'error' : m[1] === 'ECHO' ? 'echo' : m[1] === 'TRACE' ? 'echo' : 'warning';
      const lm = inLib ? null : /line (\d+)/.exec(m[2]);
      const text = m[1] + ': ' + m[2].replace(/ in file \/?input\.scad/g, '').replace(/"\/input\.scad"/g, '');
      msgs.push({ kind, line: lm ? Number(lm[1]) : null, text });
    }
    if (libDeprecated) msgs.push({ kind: 'echo', line: null, text: fmt(T.libDeprecatedHidden, { n: libDeprecated }) });
    return msgs;
  }
  // Meldungen: zuklappbar; zugeklappt zeigen Anzeigen Fehler/Warnungen/alle mit Anzahl, Punkt = neu seit dem letzten Aufklappen.
  // Neue Fehler klappen automatisch auf (Zeilen antippbar), Warnungen nicht.
  let consoleOpen = false;
  let consoleSig = '';
  let consoleSeen = '';
  let consoleCounts = { e: 0, w: 0, n: 0 };
  function setConsoleOpen(on) {
    consoleOpen = !!on;
    $('console').classList.toggle('open', consoleOpen);
    $('consoleHead').setAttribute('aria-expanded', String(consoleOpen));
    if (consoleOpen) consoleSeen = consoleSig;
    renderConsoleBadges();
  }
  function renderConsoleBadges() {
    const box = $('consoleBadges');
    box.textContent = '';
    const fresh = !consoleOpen && consoleSig !== consoleSeen;
    const add = (cls, n, title) => {
      const b = el('span', 'badge ' + cls + (fresh ? ' new' : ''), String(n));
      b.title = title + (fresh ? ' – ' + T.consoleNew : '');
      box.appendChild(b);
    };
    if (consoleCounts.e) add('err', consoleCounts.e, fmt(T.consoleErrCount, { n: consoleCounts.e }));
    if (consoleCounts.w) add('warn', consoleCounts.w, fmt(T.consoleWarnCount, { n: consoleCounts.w }));
    if (!consoleCounts.e && !consoleCounts.w) add('cnt', consoleCounts.n, fmt(T.consoleAllCount, { n: consoleCounts.n }));
  }
  function showConsole(msgs) {
    const ul = $('consoleList');
    ul.textContent = '';
    $('console').classList.toggle('hidden', msgs.length === 0);
    const hasLines = msgs.some((m) => m.line);
    $('consoleTitle').textContent = hasLines ? T.consoleErrors : T.consoleInfo;
    const prevErr = consoleCounts.e;
    consoleCounts = { e: msgs.filter((m) => m.kind === 'error').length, w: msgs.filter((m) => m.kind === 'warning').length, n: msgs.length };
    consoleSig = msgs.map((m) => m.text).join('\n');
    if (consoleCounts.e && (!prevErr || consoleSig !== consoleSeen)) setConsoleOpen(true);
    else setConsoleOpen(consoleOpen);
    if (hasLines) ul.appendChild(el('li', 'hintLine', T.consoleJumpHint));
    for (const m of msgs.slice(0, 200)) {
      const li = document.createElement('li');
      li.className = m.kind + (m.line ? ' jump' : '');
      li.textContent = m.text;
      if (m.line) li.addEventListener('click', () => editor.gotoLine(m.line));
      ul.appendChild(li);
    }
    editor.setMarks(msgs.filter((m) => m.line && m.kind !== 'echo').map((m) => ({ line: m.line, kind: m.kind })));
  }

  // ---------- OpenSCAD ----------
  let wasmBytes = null;
  let wasmOffset = 0;
  let wasmModule = null;
  let resolveWasm;
  const wasmReady = new Promise((r) => { resolveWasm = r; });
  let viewer = null;
  let rendering = false;
  let lastMsgs = null; // letzte Meldungen (für Sprachwechsel)
  let lastRun = null; // letzter Lauf: { code, preview, failed, problems } – für „Von KI reparieren lassen“
  let lastStl = null; // STL des zuletzt erfolgreich gerenderten Codes
  let lastStlCode = null;

  function isWasm(b) { return b && b.length > 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d; }

  function wasmBegin(total) {
    wasmBytes = new Uint8Array(total);
    wasmOffset = 0;
    status(fmt(T.loadingOpenscad, { pct: 0 }));
    return true;
  }
  function wasmAdd(b64) {
    const s = atob(b64);
    const buf = wasmBytes;
    let o = wasmOffset;
    for (let i = 0; i < s.length; i++) buf[o++] = s.charCodeAt(i);
    wasmOffset = o;
    progress(o / buf.length);
    status(fmt(T.loadingOpenscad, { pct: Math.round((o / buf.length) * 100) }));
    return o;
  }
  async function wasmFinish() {
    if (!isWasm(wasmBytes) || wasmOffset !== wasmBytes.length) throw new Error('WASM unvollständig: ' + wasmOffset + '/' + (wasmBytes ? wasmBytes.length : 0));
    status(T.compiling);
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    wasmModule = await WebAssembly.compile(wasmBytes);
    wasmBytes = null; // Speicher freigeben
    const ms = Math.round(performance.now() - t0);
    log('OpenSCAD kompiliert in ' + ms + ' ms.');
    if (!current) status(T.openscadReady);
    resolveWasm();
    return JSON.stringify({ ok: true, compileMs: ms });
  }

  // Rendert den aktuellen Editor-Inhalt. Ergebnis: true, wenn ein Modell entstand.
  // opts.param = true: ausgelöst durch einen Regler → keine Version sichern, Kamera bleibt, keine Zwischenanzeige.
  let lastRenderCode = null; // zuletzt gerenderter Code (auch bei Fehler)
  let slowModel = false; // Rendern zu langsam für live → Regler rendern beim Loslassen
  let pendingRender = null; // während eines Laufs angeforderter nächster Lauf (nur der neueste zählt)
  function requestRender(opts) {
    opts = opts || {};
    if (rendering) {
      // Zwischenwerte verwerfen: nur merken, DASS danach noch einmal gerendert werden soll
      const o = { param: !!opts.param, hlOnly: !!opts.hlOnly };
      if (opts.preview) pendingRender = Object.assign({}, opts);
      else pendingRender = pendingRender ? { param: pendingRender.param && o.param, hlOnly: pendingRender.hlOnly && o.hlOnly } : o;
      return Promise.resolve(false);
    }
    return render(opts).catch((e) => { status(fmt(T.error, { msg: e.message }), true); logError('render', e); return false; });
  }
  let scadLib = {}; // Dateiname → Inhalt (von Scriptable aus app/bibliothek)
  // Schriftarten für text() (7f): liegen in ScriptSCAD/fonts/, werden erst beim ersten Code mit text( von Scriptable geholt
  // und dann bei jedem Lauf nach /fonts geschrieben (dort sucht das Fontconfig des WASM-Builds).
  let fonts = null; // Dateiname → Uint8Array
  let fontsState = 'none'; // none | loading | done
  let fontsWait = [];
  let fontParts = {};
  const usesText = (code) => /\btext\s*\(/.test(String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''));
  function needFonts() {
    if (fontsState === 'done') return Promise.resolve();
    const p = new Promise((r) => { fontsWait.push(r); setTimeout(r, 120000); }); // Sicherheitsnetz: nie ewig warten
    if (fontsState === 'none') {
      fontsState = 'loading';
      status(T.loadingFonts);
      send({ type: 'needFonts' });
    }
    return p;
  }
  // ---------- 10i: Teile des Projekts (teile/*.stl …) → bei jedem Lauf als /<Name> ins Dateisystem von OpenSCAD (import("name.stl")) ----------
  let projParts = {}, partsFor = null, partChunks = {};
  function partsBegin(id) { partChunks = {}; partsFor = id; return true; }
  function partAdd(name, b64) { (partChunks[name] = partChunks[name] || []).push(b64); return true; }
  function partsDone(namesJson) {
    projParts = {};
    for (const [name, parts] of Object.entries(partChunks)) {
      const t = atob(parts.join(''));
      const b = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
      projParts[name] = b;
    }
    partChunks = {};
    const n = Object.keys(projParts).length;
    if (n) log('Teile: ' + Object.keys(projParts).join(', '));
    pickCode = null; // Antippen-Zwischenspeicher neu aufbauen
    return true;
  }
  function addPart() { if (current) send({ type: 'addPart', id: current.id }); }
  function partsAdded(json) {
    const r = JSON.parse(json);
    if (r.added.length) {
      // import-Zeile(n) an der Cursor-Stelle bzw. am Ende einfügen (rückgängig machbar)
      const v = editor.view;
      const lines = r.added.map((n) => 'import("' + n + '");').join('\n') + '\n';
      const sel = v.state.selection.main;
      const pos = v.hasFocus ? v.state.doc.lineAt(sel.head).from : v.state.doc.length;
      const pre = pos > 0 && v.state.doc.sliceString(pos - 1, pos) !== '\n' ? '\n' : '';
      editor.applyChanges([{ from: pos, to: pos, insert: pre + lines }], true);
      if (pane !== 'code') showPane('code');
      requestRender();
    }
    const msg = (r.added.length ? [fmt(T.partAddedToast, { list: r.added.join(', ') })] : []).concat(r.problems);
    if (msg.length) toast(msg.join(' · '));
  }
  function fontAdd(name, b64) { (fontParts[name] = fontParts[name] || []).push(b64); return true; }
  function fontsDone(count) {
    fonts = {};
    for (const [name, parts] of Object.entries(fontParts)) {
      const s = atob(parts.join(''));
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      fonts[name] = b;
    }
    fontParts = {};
    fontsState = 'done';
    log('Schriftarten: ' + Object.keys(fonts).length + ' (' + count + ' gemeldet)');
    fontsWait.splice(0).forEach((r) => r());
    return true;
  }
  // Fremdbibliotheken (7g): BOSL2, MCAD, NopSCADlib – liegen in ScriptSCAD/bibliotheken/, werden erst geholt, wenn ein Code sie
  // per include/use einbindet, und dann bei jedem Lauf ins Dateisystem von OpenSCAD geschrieben (/BOSL2/std.scad …).
  const LIBS = ['BOSL2', 'MCAD', 'NopSCADlib'];
  const libs = {}; // Name → { state: 'loading'|'done', files, parts, wait }
  const stripComments = (code) => String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const libsUsed = (code) => { const c = stripComments(code); return LIBS.filter((n) => new RegExp('\\b(include|use)\\s*<\\s*' + n + '/').test(c)); };
  function needLib(name) {
    const l = libs[name] || (libs[name] = { state: 'none', files: null, parts: [], wait: [] });
    if (l.state === 'done') return Promise.resolve();
    const p = new Promise((r) => { l.wait.push(r); setTimeout(r, 180000); }); // Sicherheitsnetz: nie ewig warten
    if (l.state === 'none') {
      l.state = 'loading';
      status(fmt(T.loadingLib, { name }));
      send({ type: 'needLib', name });
    }
    return p;
  }
  function libAdd(name, part) { const l = libs[name]; if (l) l.parts.push(part); return true; }
  function libDone(name, ok) {
    const l = libs[name] || (libs[name] = { wait: [] });
    l.files = {};
    try { if (ok && l.parts && l.parts.length) l.files = JSON.parse(l.parts.join('')); } catch (e) { logError('Bibliothek ' + name, e); l.files = {}; }
    l.parts = [];
    l.state = 'done';
    log('Bibliothek ' + name + ': ' + Object.keys(l.files).length + ' Dateien');
    (l.wait || []).splice(0).forEach((r) => r());
    return true;
  }
  function writeTree(FS, files) {
    const made = new Set();
    for (const [f, text] of Object.entries(files)) {
      const parts = f.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i++) {
        dir += '/' + parts[i];
        if (!made.has(dir)) { try { FS.mkdir(dir); } catch (e) { /* gibt es schon */ } made.add(dir); }
      }
      FS.writeFile('/' + f, text);
    }
  }
  // Ein OpenSCAD-Lauf in einer neuen Instanz (callMain ist pro Instanz nur einmal sicher)
  async function runScad(code, format) {
    const outFile = '/output.' + (format === 'off' ? 'off' : 'stl'); // 10k: OFF enthält die Farben aus color()
    const used = libsUsed(code);
    for (const n of used) await needLib(n);
    const withFonts = usesText(code) || used.includes('NopSCADlib'); // NopSCADlib beschriftet manche Teile mit text()
    if (withFonts) await needFonts();
    const out = [];
    const inst = await window.OpenSCAD({
      noInitialRun: true,
      print: (t) => out.push(t),
      printErr: (t) => out.push(t),
      instantiateWasm: (imports, receive) => {
        WebAssembly.instantiate(wasmModule, imports).then((i) => receive(i, wasmModule));
        return {};
      },
    });
    for (const [f, text] of Object.entries(scadLib)) inst.FS.writeFile('/' + f, text); // Bibliothek (use <scriptscad.scad>)
    if (current && partsFor === current.id) for (const [f, bytes] of Object.entries(projParts)) inst.FS.writeFile('/' + f, bytes); // 10i: Teile
    for (const n of used) if (libs[n] && libs[n].files) writeTree(inst.FS, libs[n].files);
    if (withFonts && fonts && Object.keys(fonts).length) {
      inst.FS.mkdir('/fonts');
      for (const [f, bytes] of Object.entries(fonts)) inst.FS.writeFile('/fonts/' + f, bytes);
    }
    inst.FS.writeFile('/input.scad', code);
    let rc;
    try {
      rc = inst.callMain(['/input.scad', '--backend=manifold', '-o', outFile]);
    } catch (e) {
      rc = 'Ausnahme: ' + ((e && e.message) || e);
    }
    let stl = null;
    if (rc === 0) { try { stl = inst.FS.readFile(outFile, { encoding: 'utf8' }); } catch (e) { /* leer */ } }
    if (format === 'off') return { rc, out, off: stl && /^\s*C?OFF/.test(stl) ? stl : null };
    return { rc, out, stl: stl && /facet/.test(stl) ? stl : null };
  }
  // Gewähltes Objekt farbig hervorheben: nur dieses Objekt (mit seinen Transformationen) zusätzlich rendern
  async function updateHighlight(code) {
    const hl = selectedObj == null ? null : O.highlightCode(code, selectedObj);
    if (!hl) { viewer.showHighlight(null); return; }
    const r = await runScad(hl);
    viewer.showHighlight(r.stl);
  }
  async function render(opts) {
    opts = opts || {};
    if (!current || rendering) return false;
    const code = opts.code != null ? opts.code : editor.getCode(); // opts.code: KI-Vorschlag (Vorschau)
    if (opts.hlOnly) {
      rendering = true;
      try {
        if (!wasmModule) await wasmReady;
        await updateHighlight(code);
      } finally { rendering = false; runPending(); }
      return true;
    }
    if (opts.param && code === lastRenderCode) return false; // schon gerendert (z. B. Loslassen nach Ziehen)
    rendering = true;
    lastRenderCode = code;
    if (!opts.param && !opts.preview) {
      $('btnRender').disabled = true;
      $('btnStl').disabled = true; $('btnSlicer').disabled = true;
      saveNow(true);
    }
    let renderMs = 0;
    try {
      if (!wasmModule) { status(T.waitingOpenscad); await wasmReady; }
      if (!opts.param) {
        if (!opts.preview) status(T.rendering);
        progress(0.3);
        await new Promise((r) => setTimeout(r, 30));
      }
      const t0 = performance.now();
      // 10n: leeres Projekt – nichts rendern, freundlicher Hinweis statt Fehlermeldung
      if (!code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) {
        viewer.clearModel(); viewer.showHighlight(null);
        lastStl = null; lastStlCode = null; lastMsgs = []; showConsole([]);
        lastRun = { code, preview: !!opts.preview, failed: false, warn: false, problems: [] };
        updateRepair();
        status(T.emptyProject);
        return false;
      }
      // 10n: OFF statt STL – enthält die Farben aus color(); daraus STL (Export, Slicer) und Farben je Dreieck (3D-Ansicht)
      const { rc, out, off } = await runScad(code, 'off');
      let stl = null, triCols = null;
      if (off) {
        try { const mesh = window.SCADExport.parseOff(off); stl = window.SCADExport.stl(mesh); triCols = window.SCADExport.triColors(mesh); if (!/facet/.test(stl)) stl = null; } catch (e) { logError('OFF lesen', e); }
      }
      log('OpenSCAD (' + current.name + '):\n' + out.join('\n'));
      const msgs = parseOutput(out);
      lastMsgs = msgs;
      showConsole(msgs);
      const errors = msgs.filter((m) => m.kind === 'error');
      lastStl = null; // altes Modell gilt nicht mehr für den neuen Code
      lastStlCode = null;
      const warnings = msgs.filter((m) => m.kind === 'warning');
      lastRun = { code, preview: !!opts.preview, failed: rc !== 0 || errors.length > 0, warn: warnings.length > 0,
        problems: msgs.filter((m) => m.kind !== 'echo').map((m) => m.text).concat(rc !== 0 && !errors.length ? ['ERROR: OpenSCAD beendet mit ' + rc] : []) };
      updateRepair();
      if (rc !== 0) {
        viewer.showHighlight(null);
        status(errors.length ? T.renderErrors : T.renderFailed, true);
        send({ type: 'log', text: 'Rendern fehlgeschlagen (' + rc + '): ' + errors.map((m) => m.text).join(' | ') });
        return false;
      }
      if (!stl) { viewer.showHighlight(null); status(errors.length ? T.renderErrors : T.renderEmpty, true); return false; }
      const info = viewer.showStl(stl, !!opts.param || !!opts.preview, triCols);
      if (section) renderSectionBar(); // 10g: Lage in mm zum neuen Modell anzeigen
      lastStl = stl;
      lastStlCode = code;
      await updateHighlight(code);
      renderMs = performance.now() - t0;
      const sec = (renderMs / 1000).toFixed(2);
      const dec = (x) => x.replace('.', T.decimalSep);
      const dim = [0, 1, 2].map((i) => dec((info.max[i] - info.min[i]).toFixed(1)));
      const v = { sec: dec(sec), tri: info.triangles, x: dim[0], y: dim[1], z: dim[2], n: warnings.length + errors.length };
      if (opts.param && !slowModel && renderMs > SLOW_RENDER_MS) {
        slowModel = true;
        log('Rendern langsam (' + sec + ' s) → Regler rendern beim Loslassen');
      } else if (slowModel && renderMs < FAST_RENDER_MS) slowModel = false;
      if (errors.length) status(T.renderErrors, true);
      else status(fmt(warnings.length ? T.renderDoneWarn : T.renderDone, v) + (slowModel ? ' · ' + fmt(T.paramSlow, { sec: v.sec }) : '') + (opts.preview ? ' · ' + T.aiPreviewStatus : ''));
      // Beim Ziehen am Regler nicht jeden Zwischenstand ins Scriptable-Protokoll schreiben
      if (!opts.param) send({ type: 'log', text: 'Gerendert: ' + current.name + ', ' + sec + ' s, ' + info.triangles + ' Dreiecke, ' + errors.length + ' Fehler, ' + warnings.length + ' Warnungen' });
      return true;
    } finally {
      progress(1);
      rendering = false;
      $('btnRender').disabled = false;
      $('btnStl').disabled = !lastStl; $('btnSlicer').disabled = !lastStl;
      runPending();
    }
  }
  // Knopf „Von KI reparieren lassen“ (Meldungsliste) und „Fehler an KI zurückgeben“ (KI-Vorschau)
  function updateRepair() {
    const can = !!(lastRun && (lastRun.failed || lastRun.warn) && current); // Fehler oder Warnungen → KI kann reparieren
    $('btnRepair').classList.toggle('hidden', !can);
    $('btnRepair').disabled = aiBusy;
    if (can) $('console').classList.remove('hidden');
    const box = document.querySelector('#aiState .aiPreview');
    if (!box) return;
    const bad = can && lastRun.preview && !!aiPreview && lastRun.code === aiPreview.code;
    box.classList.toggle('bad', bad);
    let b = $('aiRepairPreview');
    if (bad && !b) {
      const first = box.querySelector('.aiRow');
      box.insertBefore(el('p', 'aiBad', T.aiPreviewBad), first);
      b = el('button', 'primary', T.aiRepairPreview);
      b.id = 'aiRepairPreview';
      b.addEventListener('click', safe('Reparatur', repairNow));
      const r1 = el('div', 'aiRow aiRepairRow');
      r1.append(b);
      box.insertBefore(r1, first);
    }
    if (bad) box.scrollIntoView({ block: 'nearest' });
  }
  function runPending() {
    if (!pendingRender) return;
    const next = pendingRender;
    pendingRender = null;
    setTimeout(() => requestRender(next), 0);
  }

  // ---------- Regler: Variablen (Customizer-Syntax, params.js) und Objekte (objects.js) ----------
  let pane = 'code'; // 'code' | 'params'
  let paramSig = null; // Struktur der angezeigten Variablen-Regler
  let objSig = null; // Struktur der Objektliste (+ gewähltes Objekt)
  let applyingParam = false; // Änderung kommt vom Regler selbst → Ansicht nicht neu aufbauen
  let lastParamChange = { name: null, t: 0 };
  let collapsed = new Set(); // zugeklappte Abschnitte des aktuellen Projekts (gespeichert in project.json)
  let selectedObj = null; // Nummer des gewählten Objekts (Reihenfolge im Code)
  const P = window.SCADParams;
  const O = window.SCADObjects;
  const fmtNum = (x) => (typeof x === 'number' ? O.fmtNum(x) : String(x));

  function showPane(which) {
    if (!current) return;
    if (which === pane) return;
    if (pane === 'params') saveNow(true); // Stand nach dem Regeln als Version sichern
    pane = which;
    $('tabCode').classList.toggle('on', pane === 'code');
    $('tabParams').classList.toggle('on', pane === 'params');
    $('tabAi').classList.toggle('on', pane === 'ai');
    $('editor').classList.toggle('hidden', pane !== 'code');
    $('params').classList.toggle('hidden', pane !== 'params');
    $('aiPane').classList.toggle('hidden', pane !== 'ai');
    // Kopieren/Einfügen (ganzer Code) nur, wenn der Code-Editor gewählt ist
    $('btnCopy').classList.toggle('hidden', pane !== 'code');
    $('btnPaste').classList.toggle('hidden', pane !== 'code');
    $('histPane').classList.toggle('hidden', pane !== 'ai'); // Verlauf: eigenes Feld, nur unter KI
    if (pane === 'code') editor.remeasure();
    else editor.blur();
    if (pane === 'params') refreshParams(true);
  }

  // Änderungen aus einem Regler in den Editor übernehmen (rückgängig machbar, Ziehen = ein Schritt)
  function applyEdit(groupKey, changes) {
    const code = editor.getCode();
    const real = changes.filter((c) => code.slice(c.from, c.to) !== c.insert);
    if (!real.length) return false;
    const now = performance.now();
    // Neuer Rückgängig-Schritt, wenn ein anderer Regler bewegt wird oder etwas Zeit vergangen ist
    const newGroup = lastParamChange.name !== groupKey || now - lastParamChange.t > 800;
    lastParamChange = { name: groupKey, t: now };
    applyingParam = true;
    try { editor.applyChanges(real, newGroup); } finally { applyingParam = false; }
    return true;
  }
  // Wert einer Variablen schreiben. Ergebnis wie SCADParams.setValue.
  function applyParam(name, input) {
    const code = editor.getCode();
    const prm = P.parse(code).params.find((x) => x.name === name);
    if (!prm) return { ok: false, error: 'stale' };
    const r = P.setValue(code, prm, input);
    if (!r.ok) return r;
    applyEdit('v:' + name, [r.change]);
    return r;
  }
  function paramError(r, w) {
    if (r.error === 'option') return T.paramErrOption;
    if (r.error === 'length') return fmt(T.paramErrLength, { n: w.maxLength });
    if (r.error === 'readonly') return T.objReadOnly;
    return T.paramErrNan;
  }

  // ---------- Wert-Balken „‹ Zahl ›“ (seit 9d.2 gemeinsam mit dem Slicer: vctl.js) ----------
  // ‹ › = ein Schritt (halten = wiederholen), Zahl seitlich ziehen = ändern, antippen = eintippen, ←/→ auf der Tastatur.
  // o: { label, value, step, min, max, readOnly, text, cls, onInput(v), onCommit(v) → {ok, value}, onEnd() }
  function valueBar(o) {
    if (o.readOnly) {
      // Nur lesbar (Rechnung im Code): grauer Balken ohne Pfeile
      const bar = el('div', 'vbar ro' + (o.cls ? ' ' + o.cls : ''));
      bar.append(el('span', 'vfill'), el('span', 'vlabel', o.label || ''), el('span', 'vval', o.text));
      bar.addEventListener('click', () => toast(T.objReadOnly));
      return { el: bar, bar, set() {}, active: () => false };
    }
    const vc = window.ValueCtl.create({
      label: o.label, value: o.value, step: o.step || 1, min: o.min, max: o.max,
      format: fmtNum, onInput: o.onInput, onCommit: o.onCommit, onEnd: o.onEnd,
      onError: (where, e) => logError(where, e),
    });
    if (o.cls) vc.bar.classList.add(...o.cls.split(' ').filter(Boolean));
    return vc;
  }
  const anyBarActive = () => !!$('params').querySelector('.vbar.active');

  // Regler-Ansicht aktualisieren. force: auch wenn gerade unsichtbar.
  function refreshParams(force) {
    if (!current || (pane !== 'params' && !force)) return;
    if (anyBarActive()) return; // wird nach dem Loslassen/Eintippen nachgeholt (onEnd)
    const code = editor.getCode();
    const { params } = P.parse(code);
    const sig = P.signature(params);
    if (sig !== paramSig) { paramSig = sig; buildParams(params); } else {
      syncPresetBar(params);
      // Gleiche Struktur → nur Werte nachziehen (z. B. nach Rückgängig)
      for (const prm of params) {
        const box = $('varBox').querySelector('.param[data-name="' + prm.name + '"]');
        if (box && box._set) box._set(prm);
      }
    }
    const os = O.signature(code) + '#' + selectedObj;
    if (os !== objSig) { objSig = os; buildObjects(code); } else updateObjects(code);
  }
  const afterInteraction = () => setTimeout(() => refreshParams(false), 0);

  // Variablen: eine Gruppe /* [Name] */ = ein auf-/zuklappbarer Abschnitt. Gleichnamige Gruppen werden zusammengefasst.
  function buildParams(shown) {
    const root = $('varBox');
    root.textContent = '';
    if (!shown.length) return;
    const head = el('div', 'boxHead');
    head.appendChild(el('h3', null, T.varsTitle));
    root.appendChild(head);
    root.appendChild(presetBar());
    syncPresetBar(shown);
    const hasGroups = shown.some((p) => p.group);
    if (!hasGroups) {
      for (const prm of shown) root.appendChild(paramControl(prm));
      return;
    }
    const order = [];
    const byGroup = new Map();
    for (const prm of shown) {
      const g = prm.group || '';
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(prm);
    }
    if (order.length > 1) {
      const all = (open) => {
        collapsed = open ? new Set() : new Set(order);
        root.querySelectorAll('.pSection').forEach((s) => s.classList.toggle('open', open));
        saveUiState();
      };
      const bOpen = el('button', 'small', T.paramsAllOpen);
      bOpen.id = 'paramsAllOpen';
      bOpen.addEventListener('click', () => all(true));
      const bClose = el('button', 'small', T.paramsAllClose);
      bClose.id = 'paramsAllClose';
      bClose.addEventListener('click', () => all(false));
      head.append(bOpen, bClose);
    }
    for (const g of order) {
      const list = byGroup.get(g);
      const sec = el('div', 'pSection' + (collapsed.has(g) ? '' : ' open'));
      sec.dataset.group = g;
      const sh = el('button', 'secHead');
      sh.append(el('span', 'arrow', '▸'), el('span', 'secName', g || T.paramsGeneral), el('span', 'secCount', String(list.length)));
      sh.addEventListener('click', () => {
        const open = !sec.classList.contains('open');
        sec.classList.toggle('open', open);
        if (open) collapsed.delete(g); else collapsed.add(g);
        saveUiState();
      });
      const body = el('div', 'secBody');
      for (const prm of list) body.appendChild(paramControl(prm));
      sec.append(sh, body);
      root.appendChild(sec);
    }
  }
  function saveUiState() {
    if (current) send({ type: 'uiState', id: current.id, collapsed: Array.from(collapsed) });
  }

  function paramControl(prm) {
    const box = el('div', 'param');
    box.dataset.name = prm.name;
    const w = prm.widget;
    const label = prm.description || prm.name;
    const ctl = el('div', 'pCtl');
    const err = el('div', 'pErr');
    if (w.kind !== 'slider' && w.kind !== 'number') {
      const head = el('div', 'pHead');
      head.appendChild(el('span', 'pLabel', label));
      if (prm.description) head.appendChild(el('span', 'pName', prm.name));
      box.appendChild(head);
    }
    box.append(ctl, err);
    let cur = prm; // aktueller Stand dieses Parameters

    // Schreiben + rendern (live beim Ziehen oder beim Loslassen/Eingeben)
    const commit = (input, live) => {
      const r = applyParam(prm.name, input);
      if (!r.ok) { err.textContent = paramError(r, w); return r; }
      err.textContent = '';
      cur = Object.assign({}, cur, { value: r.value, source: r.text });
      if (!live || !slowModel) requestRender({ param: true });
      return r;
    };

    if (w.kind === 'slider' || w.kind === 'number') {
      const vb = valueBar({
        label, value: prm.value, step: w.step || 1, // ohne Grenzen, wie die Objekt-Werte (8 Pixel = ein Schritt)
        onInput: (v) => commit(v, true),
        onCommit: (v) => commit(v, false),
        onEnd: afterInteraction,
      });
      ctl.appendChild(vb.el);
      box._set = (p2) => { cur = p2; vb.set(p2.value); };
    } else if (w.kind === 'text') {
      const inp = el('input', 'txt');
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('autocapitalize', 'off');
      inp.setAttribute('spellcheck', 'false');
      if (w.maxLength) inp.maxLength = w.maxLength;
      inp.value = prm.value;
      const typed = () => { const r = commit(inp.value, false); inp.classList.toggle('bad', !r.ok); };
      inp.addEventListener('change', safe('Text', typed));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); typed(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = cur.value; inp.classList.remove('bad'); err.textContent = ''; inp.blur(); }
      });
      ctl.appendChild(inp);
      box._set = (p2) => { cur = p2; if (document.activeElement !== inp) { inp.value = p2.value; inp.classList.remove('bad'); } };
    } else if (w.kind === 'vector') {
      ctl.classList.add('vrow');
      const names = prm.value.length <= 4 ? ['x', 'y', 'z', 'w'] : prm.value.map((_, i) => String(i + 1));
      const bars = prm.value.map((v, i) => {
        const set = (x, live) => { const vals = cur.value.slice(); vals[i] = x; return commit(vals, live); };
        const vb = valueBar({
          label: names[i], value: v, step: w.step || 1,
          onInput: (x) => set(x, true),
          onCommit: (x) => { const r = set(x, false); return r.ok ? { ok: true, value: r.value[i] } : r; },
          onEnd: afterInteraction,
        });
        ctl.appendChild(vb.el);
        return vb;
      });
      box._set = (p2) => { cur = p2; bars.forEach((b, i) => b.set(p2.value[i])); };
    } else if (w.kind === 'switch') {
      const cb = el('input', 'switch');
      cb.type = 'checkbox';
      cb.checked = prm.value;
      const lbl = el('span', null, prm.value ? T.paramOn : T.paramOff);
      cb.addEventListener('change', safe('Schalter', () => { commit(cb.checked, false); lbl.textContent = cb.checked ? T.paramOn : T.paramOff; }));
      const wrap = el('label', 'pCtl');
      wrap.append(cb, lbl);
      ctl.appendChild(wrap);
      box._set = (p2) => { cur = p2; cb.checked = p2.value; lbl.textContent = p2.value ? T.paramOn : T.paramOff; };
    } else if (w.kind === 'select') {
      const sel = el('select');
      w.options.forEach((o, i) => {
        const opt = el('option', null, o.label === String(o.value) ? o.label : o.label + ' (' + o.value + ')');
        opt.value = String(i);
        sel.appendChild(opt);
      });
      const pick = (p2) => {
        const i = w.options.findIndex((o) => o.value === p2.value);
        let extra = sel.querySelector('option[value="-1"]');
        if (i < 0) { // Wert steht nicht in der Liste → als eigene Zeile anzeigen
          if (!extra) { extra = el('option'); extra.value = '-1'; extra.disabled = true; sel.appendChild(extra); }
          extra.textContent = fmtNum(p2.value);
          sel.value = '-1';
        } else {
          if (extra) extra.remove();
          sel.value = String(i);
        }
      };
      pick(prm);
      sel.addEventListener('change', safe('Auswahl', () => { const o = w.options[Number(sel.value)]; if (o) commit(o.value, false); }));
      ctl.appendChild(sel);
      box._set = (p2) => { cur = p2; pick(p2); };
    }
    return box;
  }

  // ---------- Objekte: jede Funktion (cube, sphere, cylinder …) mit Position, Drehung, Maßen, Qualität ----------
  let objBars = new Map(); // Feld-Schlüssel → Balken/Schalter des geöffneten Objekts

  // ---------- Vorlagen (7h): Parametersätze speichern/laden (model.json, Format des OpenSCAD-Customizers) ----------
  let presets = {}; // Name → { variable: Wert als Text }
  const presetNames = () => Object.keys(presets).sort((a, b) => a.localeCompare(b, 'de'));
  // Name der Vorlage, deren Werte genau dem Code entsprechen (sonst '')
  function matchingPreset(params) {
    const cur = P.presetValues(params);
    return presetNames().find((n) => {
      const set = presets[n];
      const keys = Object.keys(set).filter((k) => k in cur); // Namen, die es im Code nicht (mehr) gibt, zählen nicht
      return keys.length && keys.every((k) => String(cur[k]) === String(set[k]));
    }) || '';
  }
  function presetBar() {
    const bar = el('div', 'presetBar');
    bar.id = 'presetBar';
    const sel = el('select');
    sel.id = 'presetSel';
    sel.setAttribute('aria-label', T.presetChoose);
    sel.addEventListener('change', safe('Vorlage', () => { if (sel.value) loadPreset(sel.value); }));
    const bSave = el('button', 'small', T.presetSave);
    bSave.id = 'presetSave';
    bSave.addEventListener('click', safe('Vorlage speichern', savePreset));
    const bDel = el('button', 'small', T.presetDelete);
    bDel.id = 'presetDel';
    bDel.addEventListener('click', safe('Vorlage löschen', deletePreset));
    bar.append(sel, bSave, bDel);
    return bar;
  }
  function syncPresetBar(params) {
    const sel = $('presetSel');
    if (!sel) return;
    const names = presetNames();
    const match = matchingPreset(params || P.parse(editor.getCode()).params);
    sel.textContent = '';
    const first = el('option', null, names.length ? (match ? T.presetChoose : T.presetModified) : T.presetNone);
    first.value = '';
    sel.appendChild(first);
    for (const n of names) { const o = el('option', null, n); o.value = n; sel.appendChild(o); }
    sel.value = match;
    sel.disabled = !names.length;
    $('presetDel').disabled = !match;
  }
  function storePresets(note) { send({ type: 'presetsSave', id: current.id, sets: presets, note }); }
  function loadPreset(name) {
    const set = presets[name];
    if (!set) return;
    const r = P.applyPreset(editor.getCode(), set);
    if (r.changes.length) { applyEdit('preset:' + name + ':' + Date.now(), r.changes); requestRender({ param: true }); }
    refreshParams(true);
    toast(fmt(r.skipped.length ? T.presetLoadedSkip : T.presetLoaded, { name, n: r.skipped.length, names: r.skipped.slice(0, 5).join(', ') }));
  }
  async function savePreset() {
    const params = P.parse(editor.getCode()).params;
    if (!params.length) return;
    const def = matchingPreset(params) || fmt(T.presetDefault, { n: presetNames().length + 1 });
    const name = await dialog({ title: T.presetSaveTitle, text: T.presetSaveText, input: def, okText: T.save });
    if (!name) return;
    if (presets[name] && name !== matchingPreset(params)) {
      const ok = await dialog({ title: T.presetSaveTitle, text: fmt(T.presetOverwrite, { name }), okText: T.presetOverwriteOk });
      if (!ok) return;
    }
    presets[name] = P.presetValues(params);
    storePresets('gespeichert: ' + name);
    syncPresetBar(params);
    toast(fmt(T.presetSaved, { name }));
  }
  async function deletePreset() {
    const name = $('presetSel').value;
    if (!name || !presets[name]) return;
    const ok = await dialog({ title: T.presetDelete, text: fmt(T.presetDeleteText, { name }), okText: T.delete, danger: true });
    if (!ok) return;
    delete presets[name];
    storePresets('gelöscht: ' + name);
    syncPresetBar();
  }

  // ---------- Objekt durch Antippen in der 3D-Ansicht wählen (7h) ----------
  // Treffpunkt auf der Oberfläche → jedes Objekt einzeln (wie die Hervorhebung) gerendert, zwischengespeichert bis zur nächsten
  // Code-Änderung → das Objekt, dessen Oberfläche dem Punkt am nächsten liegt (so lassen sich auch Bohrungen antippen).
  let pickCode = null;
  let picking = false;
  async function preparePickParts(code) {
    if (pickCode === code) return true;
    const a = O.analyze(code);
    if (a.error || !a.objects.length) return false;
    status(T.pickSearching);
    const stls = [];
    for (let i = 0; i < a.objects.length; i++) {
      const hl = O.highlightCode(code, i);
      const r = hl ? await runScad(hl) : null;
      stls.push(r && r.stl);
    }
    if (editor.getCode() !== code) return false; // inzwischen geändert
    viewer.setPickParts(stls);
    pickCode = code;
    return true;
  }
  async function tapView(ndc) {
    if (!current || picking || rendering || sketching || aiPreview || viewer.isComparing()) return;
    const code = editor.getCode();
    if (!lastStl || lastStlCode !== code) { toast(T.pickRenderFirst); return; }
    const pt = viewer.pick(ndc);
    if (!pt) { if (selectedObj != null) selectObject(null); return; } // daneben getippt → Auswahl aufheben
    picking = true;
    const t0 = performance.now();
    const prev = $('status').textContent;
    const prevErr = $('status').classList.contains('error');
    try {
      if (!(await preparePickParts(code))) return;
      const hit = viewer.pickPart(pt);
      const tol = Math.max(0.5, viewer.modelSize() * 0.02);
      log('Antippen: Punkt ' + pt.map((x) => x.toFixed(1)).join('/') + ' → ' + (hit ? 'Objekt ' + hit.index + ' (' + hit.dist.toFixed(2) + ' mm)' : 'nichts') + ', ' + Math.round(performance.now() - t0) + ' ms');
      if (!hit || hit.dist > tol) return;
      showPane('params');
      needView();
      if (selectedObj === hit.index) return;
      selectObject(hit.index);
    } finally {
      picking = false;
      if ($('status').textContent === T.pickSearching) status(prev, prevErr);
    }
  }

  function selectObject(i) {
    selectedObj = i;
    refreshParams(true);
    const row = i == null ? null : $('objBox').querySelector('.objRow[data-index="' + i + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    requestRender({ hlOnly: true });
  }

  function buildObjects(code) {
    const box = $('objBox');
    box.textContent = '';
    objBars = new Map();
    const a = O.analyze(code);
    const head = el('div', 'boxHead');
    head.appendChild(el('h3', null, T.objectsTitle));
    box.appendChild(head);
    if (a.error) { box.appendChild(el('p', 'hint', fmt(T.objectsError, { msg: a.error }))); return; }
    if (!a.objects.length) { box.appendChild(el('p', 'hint', T.objectsEmpty)); return; }
    if (selectedObj != null && selectedObj >= a.objects.length) selectedObj = null;
    // Senkrechte Hilfslinien je Ebene, damit man sieht, was zu difference/if/for gehört
    const guides = (depth) => {
      const parts = [];
      for (let d = 0; d < depth; d++) { const x = 10 + d * 18; parts.push('linear-gradient(to right, transparent ' + x + 'px, #c9d1dc ' + x + 'px, #c9d1dc ' + (x + 2) + 'px, transparent ' + (x + 2) + 'px)'); }
      return parts.join(', ');
    };
    for (const t of a.tree) {
      const indent = 4 + t.depth * 18 + 'px';
      if (t.kind === 'group') {
        const g = el('div', 'objGroup', T.groupNames[t.name] || t.name);
        g.style.paddingLeft = indent;
        g.style.backgroundImage = guides(t.depth);
        box.appendChild(g);
        continue;
      }
      const info = O.inspect(code, t.index);
      const row = el('button', 'objRow' + (t.index === selectedObj ? ' sel' : '') + (t.subtract ? ' sub' : ''));
      row.dataset.index = t.index;
      row.style.paddingLeft = indent;
      if (t.depth) row.style.backgroundImage = guides(t.depth);
      row.append(el('span', 'arrow', '▸'), el('span', 'objTitle', info.title), el('span', 'objSum', info.summary));
      if (t.subtract) row.appendChild(el('span', 'objTag', T.objSubtract));
      row.addEventListener('click', safe('Objekt', () => selectObject(selectedObj === t.index ? null : t.index)));
      box.appendChild(row);
      if (t.index === selectedObj) {
        const ins = inspector(info);
        ins.style.marginLeft = 4 + t.depth * 18 + 14 + 'px';
        box.appendChild(ins);
      }
    }
  }

  function updateObjects(code) {
    const a = O.analyze(code);
    $('objBox').querySelectorAll('.objRow').forEach((row) => {
      const info = O.inspect(code, Number(row.dataset.index));
      if (info) row.querySelector('.objSum').textContent = info.summary;
    });
    if (selectedObj == null || !a.objects[selectedObj]) return;
    const info = O.inspect(code, selectedObj);
    for (const gr of info.groups) for (const f of gr.fields) { const b = objBars.get(f.key); if (b && f.editable) b.set(f.value); }
  }

  function inspector(info) {
    const box = el('div', 'inspector');
    const idx = info.index;
    const err = el('div', 'pErr');
    const commitField = (key, v, live) => {
      const r = O.setField(editor.getCode(), idx, key, v);
      if (!r.ok) {
        err.textContent = r.error !== 'range' ? paramError(r, {}) : r.max === undefined ? fmt(T.paramErrMin, { min: fmtNum(r.min) }) : fmt(T.paramErrRange, { min: fmtNum(r.min), max: fmtNum(r.max) });
        return r;
      }
      err.textContent = '';
      if (applyEdit('o' + idx + ':' + key, r.changes) && (!live || !slowModel)) requestRender({ param: true });
      return r;
    };
    const TITLES = { pos: T.objPos, rot: T.objRot, dim: T.objDim, edge: T.objEdge, quality: T.objQuality };
    for (const gr of info.groups) {
      if (!gr.fields.length) continue;
      const sec = el('div', 'insGroup');
      sec.appendChild(el('div', 'insTitle', gr.title || TITLES[gr.id] || gr.id));
      const row = el('div', 'vrow');
      const toggles = [];
      const vars = new Map();
      for (const f of gr.fields) {
        if (f.varName) vars.set(f.varName, f.uses);
        if (f.type === 'bool') {
          const cb = el('input', 'switch');
          cb.type = 'checkbox';
          cb.checked = !!f.value;
          cb.dataset.key = f.key;
          cb.addEventListener('change', safe('Schalter', () => commitField(f.key, cb.checked, false)));
          const lab = el('label', 'insToggle');
          lab.append(cb, el('span', null, f.label));
          toggles.push(lab);
          objBars.set(f.key, { set: (v) => { cb.checked = !!v; } });
          continue;
        }
        const vb = valueBar({
          label: f.label, value: f.value, step: f.step, min: f.min, max: f.max,
          readOnly: !f.editable, text: f.text, cls: f.missing ? 'missing' : '',
          onInput: (v) => commitField(f.key, v, true),
          onCommit: (v) => commitField(f.key, v, false),
          onEnd: afterInteraction,
        });
        vb.el.dataset.key = f.key;
        vb.bar.dataset.key = f.key;
        row.appendChild(vb.el);
        objBars.set(f.key, vb);
      }
      if (row.children.length) sec.appendChild(row);
      toggles.forEach((t) => sec.appendChild(t));
      vars.forEach((uses, name) => sec.appendChild(el('div', 'insHint', fmt(uses > 1 ? T.objVarShared : T.objVar, { name, n: uses }))));
      if (gr.id === 'quality' && gr.fields[0] && gr.fields[0].inherited) sec.appendChild(el('div', 'insHint', T.objQualityHint));
      if (gr.id === 'edge') sec.appendChild(el('div', 'insHint', gr.kind === 'none' ? T.objEdgeHint : T.objEdgeHintOn));
      box.appendChild(sec);
    }
    box.appendChild(err);
    const foot = el('div', 'insFoot');
    const goto = el('button', 'small', fmt(T.objShowCode, { n: info.line }));
    goto.addEventListener('click', () => { showPane('code'); editor.gotoLine(info.line); });
    foot.appendChild(goto);
    box.appendChild(foot);
    return box;
  }

  // ---------- KI: Wunsch senden, Vorschlag ansehen, übernehmen oder verwerfen ----------
  let aiBusy = false;
  let aiPreview = null; // { code, reqId, text } solange ein Vorschlag angezeigt wird
  let aiHistory = [];
  let aiWish = ''; // Wunsch der laufenden Anfrage (bleibt bei Reparaturen erhalten)
  let aiCancel = false; // Nutzer bricht das Warten auf die Antwortdatei ab

  function buildAiPane() {
    const pane = $('aiPane');
    pane.textContent = '';
    // Agent: Auswahl über Symbole; die (unsichtbare) Liste bleibt die eigentliche Auswahl (Tastatur, VoiceOver, Tests)
    const lab = el('div', 'aiLabel agentRow');
    const sel = el('select', 'srOnly');
    sel.id = 'aiAgent';
    sel.setAttribute('aria-label', T.aiAgentLabel);
    for (const a of T.agents) { const o = el('option', null, a.label); o.value = a.id; sel.appendChild(o); }
    sel.value = settings.aiAgent || T.agents[0].id;
    const icons = el('div', 'agents');
    icons.setAttribute('role', 'radiogroup');
    icons.setAttribute('aria-label', T.aiAgentChoose);
    const agentName = el('span', 'agentName');
    agentName.id = 'aiAgentName';
    const syncAgents = () => {
      icons.querySelectorAll('.agent').forEach((b) => { const on = b.dataset.id === sel.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      agentName.textContent = (T.agents.find((a) => a.id === sel.value) || {}).label || '';
      const ch = $('aiClaudeHint');
      if (ch) ch.classList.toggle('hidden', sel.value !== 'claude-app');
      syncSendButton();
    };
    for (const a of T.agents) {
      const b = el('button', 'agent');
      b.dataset.id = a.id;
      b.id = 'agent-' + a.id;
      b.title = a.label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', a.label);
      b.innerHTML = AGENT_ICON[a.id] || ICON.cube;
      b.addEventListener('click', () => { if (sel.value === a.id) return; sel.value = a.id; sel.dispatchEvent(new Event('change')); });
      icons.appendChild(b);
    }
    sel.addEventListener('change', () => { syncAgents(); saveSettings({ aiAgent: sel.value }); });
    sel._sync = syncAgents;
    lab.append(sel, icons, agentName);
    syncAgents();
    const ta = el('textarea');
    ta.id = 'aiPrompt';
    ta.placeholder = T.aiPlaceholder;
    ta.rows = 5;
    ta.addEventListener('input', () => autoGrow(ta));
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); aiSendNow(); }
    });
    // Anhänge: Skizze, Datei-Upload (Galerie oder Dateien-App), Ansicht mitschicken
    const att = el('div', 'aiAttBox');
    att.appendChild(el('div', 'aiSub', T.aiAttachments));
    const ab = el('div', 'aiRow');
    const bSketch = el('button', 'ico');
    bSketch.innerHTML = ICON.sketch + '<span>' + T.aiSketch + '</span>';
    bSketch.id = 'aiSketchBtn';
    bSketch.addEventListener('click', safe('Skizze', startSketch));
    const bFile = el('button', 'ico');
    bFile.innerHTML = ICON.upload + '<span>' + T.aiUpload + '</span>';
    bFile.id = 'aiFileBtn';
    bFile.title = T.aiUploadTitle;
    bFile.addEventListener('click', safe('Datei-Upload', pickUpload));
    ab.append(bSketch, bFile);
    const wv = el('label', 'aiCheck');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'aiWithView';
    wv.append(cb, el('span', null, T.aiWithView));
    const thumbs = el('div', 'aiAttList');
    thumbs.id = 'aiAtt';
    att.append(ab, wv, thumbs);
    const sendBtn = el('button', 'primary withIcon');
    sendBtn.id = 'aiSend';
    sendBtn.addEventListener('click', safe('KI senden', aiSendNow));
    // Claude-App (7f): Antwort aus der Zwischenablage holen (wie „Einfügen“ in der Code-Kopfzeile)
    const pasteBtn = el('button', 'withIcon hidden');
    pasteBtn.id = 'aiPasteAnswer';
    pasteBtn.innerHTML = ICON.paste + '<span></span>';
    pasteBtn.lastChild.textContent = T.aiPasteAnswer;
    pasteBtn.title = T.pasteCode;
    pasteBtn.addEventListener('click', safe('Antwort einfügen', () => { if (aiPreview) endPreview(false, true); send({ type: 'pasteCode' }); }));
    // Hinweis rechts neben dem Knopf (Tastenkürzel ⌘↩ steht im title des Knopfs)
    const hint = el('p', 'aiHint');
    hint.id = 'aiSendHint';
    const row = el('div', 'aiRow aiSendRow');
    row.append(sendBtn, pasteBtn, hint);
    const state = el('div');
    state.id = 'aiState';

    // Hinweis über „An KI senden“, solange die Claude-App gewählt ist (Zeitlimit ihrer Aktion, iPad 2026-11-06)
    const claudeHint = el('p', 'aiClaudeHint' + (sel.value === 'claude-app' ? '' : ' hidden'), T.aiClaudeHint);
    claudeHint.id = 'aiClaudeHint';
    pane.append(lab, ta, att, claudeHint, row, state);
    syncSendButton();
    renderAiHistory();
    renderAttachments();
  }

  // Claude-App (7f): statt „An KI senden“ wird der Auftrag als ein Text in die Zwischenablage kopiert
  const copyMode = () => !!$('aiAgent') && $('aiAgent').value === 'claude-app';
  function syncSendButton() {
    const b = $('aiSend');
    if (!b) return;
    const copy = copyMode();
    b.innerHTML = (copy ? ICON.copy : ICON.send) + '<span></span>';
    b.lastChild.textContent = copy ? T.aiCopyPrompt : T.aiSend;
    b.title = copy ? T.aiCopyPromptTitle : T.aiSendTitle;
    $('aiPasteAnswer').classList.toggle('hidden', !copy);
    $('aiSendHint').textContent = copy ? T.aiCopyHint : fmt(T.aiSendHint, { name: 'ScriptSCAD KI' });
  }
  function aiCopied(r) {
    if ($('aiSend')) $('aiSend').disabled = false;
    $('btnRepair').disabled = false;
    const state = $('aiState');
    state.textContent = '';
    if (!r.ok) {
      const msg = fmt(T.aiCopyFailed, { msg: r.error || '?' });
      state.appendChild(el('p', 'aiError', msg));
      status(msg, true);
      return;
    }
    const box = el('div', 'aiCopied');
    box.appendChild(el('p', 'aiCopiedTitle', fmt(T.aiCopiedTitle, { n: r.chars.toLocaleString(T.dateLocale) })));
    const ol = el('ol');
    for (const t of T.aiCopiedSteps) ol.appendChild(el('li', null, t));
    box.appendChild(ol);
    const extra = [];
    if (r.view) extra.push(r.photo ? (r.sketch ? T.aiCopiedSketchPhoto : T.aiCopiedViewPhoto) : T.aiCopiedViewNoPhoto);
    for (const n of r.attach || []) extra.push('„' + n + '“');
    if (extra.length) box.appendChild(el('p', 'aiCopiedAttach', fmt(T.aiCopiedAttach, { list: extra.join(', ') })));
    state.appendChild(box);
    status(T.aiCopiedStatus);
    toast(T.aiCopiedStatus);
  }
  function aiCopyNow(payload) {
    $('aiSend').disabled = true;
    $('btnRepair').disabled = true;
    $('aiState').textContent = '';
    saveNow(true); // Stand vor der KI-Anfrage als Version sichern
    send(Object.assign({ type: 'aiCopy', agent: 'claude-app' }, payload));
  }

  // KI-Eingabefeld: Standardhöhe bleibt, bei mehr Text/Zeilen wächst es mit (der KI-Bereich scrollt)
  function autoGrow(ta) {
    ta.style.height = 'auto';
    const min = parseFloat(getComputedStyle(ta).minHeight) || 0;
    ta.style.height = Math.max(min, ta.scrollHeight + 2) + 'px';
  }
  function aiSendNow() {
    if (!current || aiBusy) return;
    const prompt = $('aiPrompt').value.trim();
    if (!prompt) { toast(T.aiEmptyPrompt); $('aiPrompt').focus(); return; }
    if (aiPreview) endPreview(false, true);
    aiWish = prompt;
    const agent = $('aiAgent').value;
    const view = aiSketch || ($('aiWithView').checked ? composeView(false) : null);
    if (copyMode()) { aiCopyNow({ id: current.id, prompt, code: editor.getCode(), view, sketch: !!aiSketch, files: aiFiles.map((f) => f.file) }); return; }
    startAiWait();
    send({ type: 'aiSend', id: current.id, agent, prompt, code: editor.getCode(), view, sketch: !!aiSketch, files: aiFiles.map((f) => f.file) });
  }

  // Fehler (des Editor-Codes oder des KI-Vorschlags) an dieselbe KI zurückgeben
  async function repairNow() {
    if (!current || aiBusy) return;
    // Editor-Code inzwischen geändert → erst neu rendern, damit die Meldungen zum Code passen
    if (!aiPreview && (!lastRun || lastRun.preview || lastRun.code !== editor.getCode())) await requestRender();
    if (!lastRun || (!lastRun.failed && !lastRun.warn)) { toast(T.aiRepairNothing); return; }
    const run = lastRun;
    const wish = run.preview && aiPreview ? aiPreview.wish || '' : '';
    if (aiPreview) endPreview(false, true);
    showPane('ai');
    aiWish = wish;
    if (copyMode()) { aiCopyNow({ mode: 'repair', id: current.id, prompt: wish, code: run.code, errors: run.problems }); return; }
    startAiWait();
    send({ type: 'aiSend', mode: 'repair', id: current.id, agent: $('aiAgent').value, prompt: wish, code: run.code, errors: run.problems });
  }
  function startAiWait() {
    saveNow(true); // Stand vor der KI-Anfrage als Version sichern
    aiBusy = true;
    aiCancel = false;
    $('aiSend').disabled = true;
    $('btnRepair').disabled = true;
    $('aiPrompt').blur();
    const agent = $('aiAgent').value;
    const label = (T.agents.find((a) => a.id === agent) || {}).label || agent;
    $('aiState').textContent = '';
    $('aiState').appendChild(el('p', 'aiWait', fmt(T.aiWaiting, { agent: label })));
    status(fmt(T.aiWaiting, { agent: label }));
    progress(0.5);
  }

  // Einfacher Zeilenvergleich (LCS) für die Kurzbeschreibung des Vorschlags
  function lineDiff(a, b) {
    const x = a.replace(/\s+$/, '').split('\n');
    const y = b.replace(/\s+$/, '').split('\n');
    if (x.length * y.length > 4e6) return { plus: y.length, minus: x.length };
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const same = dp[0][0];
    return { plus: m - same, minus: n - same };
  }

  function aiResult(r) {
    aiBusy = false;
    progress(1);
    if ($('aiSend')) $('aiSend').disabled = false;
    $('btnRepair').disabled = false;
    const state = $('aiState');
    state.textContent = '';
    if (!r.ok) {
      const msg = fmt(T.aiFailed, { msg: r.error || '?' });
      state.appendChild(el('p', 'aiError', msg));
      status(msg.split('\n')[0], true);
      return;
    }
    aiPreview = { code: r.code, reqId: r.reqId, text: r.text || '', wish: aiWish };
    needView();
    // „Vorher“ für den Vergleich: zuletzt erfolgreich gerendertes Modell des aktuellen Codes
    const before = lastStl && lastStlCode === editor.getCode() ? lastStl : null;
    viewer.setCompare(before);
    showPane('ai');
    const box = el('div', 'aiPreview');
    box.appendChild(el('h4', null, T.aiPreviewTitle));
    const d = lineDiff(editor.getCode(), r.code);
    // Ersetzte Zeilen als „geändert“ zählen, Rest als neu/entfernt
    const ch = Math.min(d.plus, d.minus);
    const parts = [];
    if (ch) parts.push(fmt(T.aiDiffChanged, { n: ch }));
    if (d.plus - ch) parts.push(fmt(T.aiDiffAdded, { n: d.plus - ch }));
    if (d.minus - ch) parts.push(fmt(T.aiDiffRemoved, { n: d.minus - ch }));
    box.appendChild(el('p', 'aiDiff', parts.length ? parts.join(' · ') : T.aiSame));
    if (aiPreview.text) box.appendChild(el('p', 'aiText', aiPreview.text));
    // Zeile 1: Code ansehen | Vergleich (halten); Zeile 2 (hervorgehoben): Übernehmen (grün) | Verwerfen (rot) – je halbe Breite
    const withIcon = (cls, icon, text) => { const b = el('button', cls); b.innerHTML = icon + '<span></span>'; b.lastChild.textContent = text; return b; };
    const btns = el('div', 'aiRow aiPair');
    const decide = el('div', 'aiPair aiDecide');
    const acc = withIcon('withIcon aiAcceptBtn', ICON.check, T.aiAccept);
    acc.id = 'aiAccept';
    acc.addEventListener('click', safe('übernehmen', () => endPreview(true)));
    const dis = withIcon('withIcon aiDiscardBtn', ICON.cross, T.aiDiscard);
    dis.id = 'aiDiscard';
    dis.addEventListener('click', safe('verwerfen', () => endPreview(false)));
    const view = withIcon('withIcon', ICON.code, T.aiShowCode);
    view.id = 'aiViewCode';
    view.addEventListener('click', () => {
      const body = openPanel(T.aiCodeTitle);
      body.appendChild(el('pre', 'aiCode', aiPreview ? aiPreview.code : ''));
    });
    // Vergleich: halten = altes Modell zeigen, loslassen = Vorschlag (Finger, Pencil, Maus; Hardware-Tastatur: Leertaste halten)
    const cmp = withIcon('withIcon aiCompare', ICON.compare, T.aiCompare);
    cmp.id = 'aiCompare';
    if (!before) { cmp.disabled = true; cmp.title = T.aiCompareNone; }
    const cmpOn = (e) => { if (e) e.preventDefault(); if (viewer.showCompare(true)) { cmp.classList.add('active'); $('view').dataset.badge = T.aiCompareBadge; $('view').classList.add('comparing'); } };
    const cmpOff = () => { viewer.showCompare(false); cmp.classList.remove('active'); $('view').classList.remove('comparing'); };
    cmp.addEventListener('pointerdown', (e) => { try { cmp.setPointerCapture(e.pointerId); } catch (x) { /* egal */ } cmpOn(e); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) cmp.addEventListener(ev, cmpOff);
    cmp.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) cmpOn(e); });
    cmp.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') cmpOff(); });
    cmp.addEventListener('contextmenu', (e) => e.preventDefault());
    btns.append(view, cmp);
    decide.append(acc, dis);
    box.append(btns, decide);
    state.appendChild(box);
    selectedObj = null;
    viewer.showHighlight(null);
    $('btnStl').disabled = true; $('btnSlicer').disabled = true;
    requestRender({ code: r.code, preview: true });
  }

  // accepted: Vorschlag übernehmen (rückgängig machbar) oder verwerfen. silent: ohne Meldung (z. B. neue Anfrage)
  function endPreview(accepted, silent) {
    if (!aiPreview) return;
    const p = aiPreview;
    aiPreview = null;
    viewer.setCompare(null);
    $('view').classList.remove('comparing');
    $('aiState').textContent = '';
    send({ type: 'aiDecision', id: current.id, reqId: p.reqId, accepted });
    if (accepted) {
      saveNow(true);
      applyingParam = true; // Regler-Ansicht erst nach dem Rendern neu aufbauen
      try { editor.replaceAll(p.code); } finally { applyingParam = false; }
      updateDirty();
      refreshParams(false);
      saveNow(true);
      if (!silent) toast(T.aiAccepted);
      requestRender();
    } else {
      if (!silent) toast(T.aiDiscarded);
      lastRenderCode = null;
      requestRender({ param: true });
    }
  }

  function renderAiHistory() {
    const ul = $('aiHistory');
    if (!ul) return;
    ul.textContent = '';
    $('aiHistCount').textContent = String(aiHistory.length);
    $('aiHistCount').title = fmt(T.aiHistoryCount, { n: aiHistory.length });
    if (!aiHistory.length) { ul.appendChild(el('li', 'hint', T.aiHistoryEmpty)); return; }
    for (const h of aiHistory.slice().reverse().slice(0, 30)) {
      const li = el('li', 'aiItem');
      const top = el('div', 'aiItemTop');
      const agent = (T.agents.find((a) => a.id === h.agent) || {}).label || h.agent;
      let date = h.time;
      try { date = new Date(h.time).toLocaleString(T.dateLocale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { /* egal */ }
      top.append(el('span', 'aiItemDate', date + ' · ' + agent), el('span', 'aiChip ' + h.result, T.aiResult[h.result] || h.result));
      li.append(top, el('div', 'aiItemText', h.prompt));
      if (h.result === 'error' && h.note) li.appendChild(el('div', 'aiItemNote', h.note.split('\n')[0]));
      if (h.mode !== 'repair') li.addEventListener('click', () => { $('aiPrompt').value = h.prompt; autoGrow($('aiPrompt')); $('aiPrompt').focus(); });
      ul.appendChild(li);
    }
  }

  // ---------- Bilder für die KI: Skizze auf der 3D-Ansicht, Foto aus der Galerie ----------
  let aiSketch = null; // JPEG (base64) der Ansicht mit Skizze
  // Hochgeladene Dateien (8a.9): [{ file, name, kind, label, thumb?, note? }] – die Dateien selbst liegen bei Scriptable (ai/upload-…)
  let aiFiles = [];
  async function pickUpload() {
    const source = await dialog({ title: T.aiUploadTitle, text: T.aiUploadText, buttons: [
      { id: 'dlgUpPhotos', label: T.aiUploadPhotos, value: 'photos', cls: 'primary' },
      { id: 'dlgUpFiles', label: T.aiUploadFiles, value: 'files', cls: 'primary' },
      { id: 'dlgCancel', label: T.cancel, value: null },
    ] });
    if (source) send({ type: 'aiPickFile', source });
  }
  let sketching = false;
  let strokes = []; // [{ color, pts: [[x, y, druck], …] }] – x/y relativ zur Ansichtsgröße (0…1)
  let sketchColor = '#e0281e';
  const SKETCH_COLORS = ['#e0281e', '#1f6fff', '#ffd60a']; // Gelb statt Schwarz: auf dunklem und hellem Hintergrund sichtbar
  const MAX_IMG = 1600;

  // Ansicht (+ Striche) als JPEG, lange Seite höchstens MAX_IMG Pixel
  function composeView(withStrokes) {
    const src = viewer.snapshotCanvas();
    const f = Math.min(1, MAX_IMG / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * f);
    c.height = Math.round(src.height * f);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (withStrokes) drawStrokes(ctx, c.width, c.height, c.width / ($('view').clientWidth || c.width));
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }
  function drawStrokes(ctx, w, h, scale) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      for (let i = 1; i < s.pts.length; i++) {
        const [x0, y0] = s.pts[i - 1];
        const [x1, y1, p] = s.pts[i];
        ctx.lineWidth = (2 + 4 * (p || 0.5)) * scale;
        ctx.beginPath();
        ctx.moveTo(x0 * w, y0 * h);
        ctx.lineTo(x1 * w, y1 * h);
        ctx.stroke();
      }
      if (s.pts.length === 1) { // Punkt
        const [x, y] = s.pts[0];
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(x * w, y * h, 3 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  function redrawSketch() {
    const cv = $('sketch');
    const w = $('view').clientWidth;
    const h = $('view').clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawStrokes(ctx, w, h, 1);
  }

  function startSketch() {
    if (!current || sketching) return;
    needView();
    sketching = true;
    strokes = [];
    const bar = $('sketchBar');
    bar.textContent = '';
    bar.appendChild(el('span', 'sketchHint', T.sketchHint));
    const colors = el('span', 'sketchColors');
    for (const c of SKETCH_COLORS) {
      const b = el('button', 'sketchColor' + (c === sketchColor ? ' on' : ''));
      b.style.background = c;
      b.setAttribute('aria-label', c);
      b.addEventListener('click', () => { sketchColor = c; colors.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); });
      colors.appendChild(b);
    }
    const mk = (id, text, cls, fn) => { const b = el('button', cls || '', text); b.id = id; b.addEventListener('click', safe('Skizze', fn)); return b; };
    bar.append(colors,
      mk('sketchUndo', T.sketchUndo, '', () => { strokes.pop(); redrawSketch(); }),
      mk('sketchClear', T.sketchClear, '', () => { strokes = []; redrawSketch(); }),
      mk('sketchCancel', T.sketchCancel, '', () => endSketch(false)),
      mk('sketchDone', T.sketchDone, 'primary', () => endSketch(true)));
    $('sketch').classList.remove('hidden');
    bar.classList.remove('hidden');
    $('viewHelp').classList.add('hidden');
    redrawSketch();
  }
  function endSketch(keep) {
    if (!sketching) return;
    if (keep && !strokes.length) { toast(T.sketchEmpty); return; }
    if (keep) aiSketch = composeView(true);
    sketching = false;
    strokes = [];
    redrawSketch();
    $('sketch').classList.add('hidden');
    $('sketchBar').classList.add('hidden');
    $('viewHelp').classList.remove('hidden');
    renderAttachments();
    if (keep) showPane('ai');
  }
  function initSketchCanvas() {
    const cv = $('sketch');
    let cur = null;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, p];
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!sketching) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      cur = { color: sketchColor, pts: [pos(e)], id: e.pointerId };
      strokes.push(cur);
      redrawSketch();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!cur || e.pointerId !== cur.id) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) cur.pts.push(pos(ev));
      redrawSketch();
    });
    const up = (e) => { if (cur && e.pointerId === cur.id) cur = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => { if (sketching) redrawSketch(); });
  }

  function renderAttachments() {
    const box = $('aiAtt');
    if (!box) return;
    box.textContent = '';
    const item = (label, b64, onRemove, cls) => {
      const d = el('div', 'aiThumb ' + cls);
      const img = el('img');
      img.src = 'data:image/jpeg;base64,' + b64;
      img.alt = label;
      const rm = el('button', 'small', '✕ ' + T.aiAttRemove);
      rm.addEventListener('click', safe('Bild entfernen', onRemove));
      d.append(img, el('span', null, label), rm);
      box.appendChild(d);
    };
    // Datei ohne Vorschaubild: Kachel mit Symbol und Endung
    const fileItem = (f, onRemove) => {
      const d = el('div', 'aiThumb file ' + f.kind);
      const tile = el('div', 'aiFileTile');
      tile.innerHTML = ICON.file;
      const ext = (/\.([^.]+)$/.exec(f.name) || [])[1];
      tile.appendChild(el('b', null, ext ? ext.toUpperCase().slice(0, 5) : '?'));
      if (f.note) tile.title = f.note;
      const rm = el('button', 'small', '✕ ' + T.aiAttRemove);
      rm.addEventListener('click', safe('Datei entfernen', onRemove));
      d.append(tile, el('span', null, f.name), el('small', null, f.label + (f.kind === 'stl' && f.note ? ' · ' + f.note.replace(/ \(X.*$/, '') : '')), rm);
      box.appendChild(d);
    };
    if (aiSketch) item(T.aiAttSketch, aiSketch, () => { aiSketch = null; renderAttachments(); }, 'sketch');
    for (const f of aiFiles) {
      const remove = () => { aiFiles = aiFiles.filter((x) => x !== f); send({ type: 'aiRemoveFile', file: f.file }); renderAttachments(); };
      if (f.thumb) item(f.name, f.thumb, remove, 'photo upload');
      else fileItem(f, remove);
    }
    $('aiWithView').disabled = !!aiSketch; // Skizze enthält die Ansicht schon
  }

  async function exportStl() {
    if (!current) return;
    while (rendering) await new Promise((r) => setTimeout(r, 50));
    if (!lastStl || lastStlCode !== editor.getCode()) {
      const ok = await render();
      if (!ok) { toast(T.stlNeedsRender); return; }
    }
    saveNow();
    send({ type: 'exportStl', id: current.id, stl: lastStl });
  }
  // 9i: wie STL-Export, danach startet Scriptable den Slicer mit diesem Projekt
  async function openSlicer() {
    if (!current) return;
    while (rendering) await new Promise((r) => setTimeout(r, 50));
    if (!lastStl || lastStlCode !== editor.getCode()) {
      const ok = await render();
      if (!ok) { toast(T.slicerNeedsRender); return; }
    }
    saveNow();
    status(T.slicerOpening);
    send({ type: 'openSlicer', id: current.id, stl: lastStl });
  }

  // ---------- 10g: Schnittansicht (Ebene X/Y/Z, Lage per Regler, Seite wechseln) ----------
  let section = null;
  function setSection(c) {
    section = c;
    $('btnSection').classList.toggle('on', !!section);
    if (section) needView();
    renderSectionBar();
  }
  function renderSectionBar() {
    const bar = $('sectionBar');
    bar.classList.toggle('hidden', !section);
    if (!section) { viewer.setClip(null); return; }
    const r = viewer.setClip(section);
    bar.innerHTML = '';
    const segs = document.createElement('span'); segs.className = 'segs';
    for (const ax of ['x', 'y', 'z']) {
      const b = document.createElement('button'); b.textContent = ax.toUpperCase(); b.dataset.axis = ax; b.classList.toggle('on', section.axis === ax);
      b.addEventListener('click', () => setSection(Object.assign({}, section, { axis: ax })));
      segs.appendChild(b);
    }
    bar.appendChild(segs);
    const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 1000; range.value = Math.round(section.t * 1000); range.id = 'sectionPos';
    range.setAttribute('aria-label', T.sectionPos);
    const val = document.createElement('span'); val.className = 'secVal';
    const showVal = (res) => { val.textContent = res ? section.axis.toUpperCase() + ' = ' + fmtMm(res.pos) + ' mm' : T.sectionNoModel; };
    range.addEventListener('input', () => { section.t = range.value / 1000; showVal(viewer.setClip(section)); });
    bar.appendChild(range);
    bar.appendChild(val);
    showVal(r);
    const flip = document.createElement('button'); flip.textContent = T.sectionFlip; flip.id = 'sectionFlip';
    flip.addEventListener('click', () => setSection(Object.assign({}, section, { flip: !section.flip })));
    bar.appendChild(flip);
    const x = document.createElement('button'); x.textContent = '×'; x.title = T.close; x.setAttribute('aria-label', T.close); x.id = 'sectionClose';
    x.addEventListener('click', () => setSection(null));
    bar.appendChild(x);
  }
  const fmtMm = (v) => (Math.round(v * 10) / 10).toLocaleString(document.documentElement.lang || 'de');

  // ---------- 10k: Export – Formatwahl (STL · 3MF mit Farben · STL je Körper) ----------
  async function exportMenu() {
    if (!current) return;
    const choice = await dialog({
      title: T.exportTitle, text: T.exportText,
      buttons: [
        { id: 'expCancel', label: T.cancel, value: null },
        { id: 'expBodies', label: T.exportBodies, value: 'bodies' },
        { id: 'exp3mf', label: T.export3mf, value: '3mf' },
        { id: 'expStl', label: T.exportStlOne, value: 'stl', cls: 'primary' },
      ],
    });
    if (choice === 'stl') return exportStl();
    if (choice === '3mf' || choice === 'bodies') return exportOff(choice);
  }
  async function exportOff(kind) {
    while (rendering) await new Promise((r) => setTimeout(r, 50));
    if (!lastStl || lastStlCode !== editor.getCode()) {
      const ok = await render();
      if (!ok) { toast(T.stlNeedsRender); return; }
    }
    saveNow();
    status(T.exportWorking);
    const code = editor.getCode();
    const r = await runScad(code, 'off');
    if (!r.off) { status(fmt(T.error, { msg: 'OFF-Ausgabe leer' }), true); return; }
    const X = window.SCADExport;
    const mesh = X.parseOff(r.off);
    const base = current.name;
    const files = [];
    if (kind === '3mf') {
      const groups = X.byColor(mesh).map((g, i) => ({ name: g.color ? fmt(T.exportColor, { n: i + 1, hex: X.hex(g.color) }) : T.exportNoColor, color: g.color, faces: g.faces }));
      const bytes = X.make3mf(mesh, groups, base);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      files.push({ name: base + '.3mf', b64: btoa(bin) });
      log('3MF: ' + groups.length + ' Farbgruppe(n), ' + Math.round(bytes.length / 1024) + ' KB');
      status(fmt(T.export3mfDone, { n: groups.length }));
    } else {
      const parts = X.bodies(mesh);
      parts.forEach((fs, i) => files.push({ name: base + '-' + T.exportPart + '-' + (i + 1) + '.stl', text: X.stl(mesh, fs, base + ' ' + (i + 1)) }));
      log('Körper: ' + parts.length);
      status(fmt(T.exportBodiesDone, { n: parts.length }));
      if (parts.length === 1) toast(T.exportOneBody);
    }
    send({ type: 'exportFiles', id: current.id, files });
  }

  // ---------- Fenster: Versionen & Einstellungen ----------
  let settings = { openLast: false, fontSize: 15, historyMax: 20, viewMode: 'both', splitWide: 42, splitTall: 50, theme: 'system' };
  function applySettings() {
    $('editor').style.fontSize = settings.fontSize + 'px';
    if (editor) editor.remeasure();
    applyTheme();
    applyLayout();
  }

  // ---------- Darstellung: dunkel / hell / automatisch (wie iPad) ----------
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let deviceDark = null; // von Scriptable: Device.isUsingDarkAppearance()
  const VIEWER_THEME = {
    dark: { bg: 0x161615, grid1: 0x4a4a46, grid2: 0x262624, model: 0xff4f1a },
    light: { bg: 0xffffff, grid1: 0xb5b5ae, grid2: 0xe4e4de, model: 0xff4f1a },
  };
  function effectiveTheme() {
    const t = settings.theme;
    if (t === 'dark' || t === 'light') return t;
    if (darkQuery && darkQuery.matches) return 'dark';
    if (deviceDark != null) return deviceDark ? 'dark' : 'light';
    return darkQuery ? 'light' : 'dark';
  }
  let shownTheme = null;
  function applyTheme() {
    const th = effectiveTheme();
    if (th === shownTheme) return;
    shownTheme = th;
    document.documentElement.dataset.theme = th;
    if (viewer && viewer.setTheme) viewer.setTheme(VIEWER_THEME[th]);
  }
  if (darkQuery) {
    const onSys = () => { if (settings.theme === 'system' || !settings.theme) applyTheme(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSys); else if (darkQuery.addListener) darkQuery.addListener(onSys);
  }

  // Statuszeile: im Projekt oben links in der 3D-Ansicht (bzw. über dem Bearbeitungsbereich, wenn die Ansicht aus ist), sonst in der Liste
  function placeStatus() {
    const st = $('status');
    const inProject = !$('screenProject').classList.contains('hidden');
    const viewShown = inProject && !$('view').classList.contains('hidden');
    let parent;
    let before = null;
    if (viewShown) parent = $('view');
    else if (inProject) { parent = $('codePane'); before = $('paneTabs').nextSibling; } else { parent = $('screenList'); before = $('projectList'); }
    if (st.parentNode !== parent) parent.insertBefore(st, before);
    st.classList.toggle('chip', viewShown);
    st.classList.toggle('line', !viewShown);
  }

  // ---------- Aufteilung Bearbeiten / 3D ----------
  const SPLIT_DEFAULT = { wide: 42, tall: 50 }; // Prozent für den Bearbeitungsbereich (quer / hochkant)
  const SPLIT_MIN_PX = 160; // so klein darf jede Seite höchstens werden
  let split = null; // UICommon.splitter (10b)
  const isTall = () => getComputedStyle($('screenProject')).flexDirection === 'column';
  const splitKey = () => (isTall() ? 'splitTall' : 'splitWide');
  function splitPct() {
    const d = split && split.dragging();
    if (d != null) return d;
    const v = settings[splitKey()];
    return typeof v === 'number' ? v : (isTall() ? SPLIT_DEFAULT.tall : SPLIT_DEFAULT.wide);
  }
  function applyLayout() {
    const mode = settings.viewMode === 'edit' || settings.viewMode === 'view' ? settings.viewMode : 'both';
    $('codePane').classList.toggle('hidden', mode === 'view');
    $('view').classList.toggle('hidden', mode === 'edit');
    $('splitter').classList.toggle('hidden', mode !== 'both');
    $('codePane').style.flex = mode === 'edit' ? '1 1 auto' : '0 0 ' + splitPct() + '%';
    for (const m of ['edit', 'both', 'view']) $('mode' + m[0].toUpperCase() + m.slice(1)).classList.toggle('on', m === mode);
    placeStatus();
  }
  function setViewMode(mode) {
    if (settings.viewMode === mode) return;
    saveSettings({ viewMode: mode });
  }
  // 3D-Ansicht wird gebraucht (Skizze, KI-Vorschlag) → bei „nur Bearbeiten“ auf „beides“ umschalten
  function needView() { if (settings.viewMode === 'edit') setViewMode('both'); }
  function initSplitter() {
    split = UICommon.splitter({ el: $('splitter'), container: $('screenProject'), isTall, current: splitPct, defaults: SPLIT_DEFAULT, minPx: SPLIT_MIN_PX,
      layout: applyLayout, save: (pct) => saveSettings({ [splitKey()]: pct }) });
    // Drehen / Fenstergröße: richtige Aufteilung (quer / hochkant) anwenden
    window.addEventListener('resize', () => applyLayout());
  }
  function openPanel(title) {
    $('panelTitle').textContent = title;
    $('panelBody').textContent = '';
    $('panel').classList.remove('hidden');
    return $('panelBody');
  }
  function closePanel() { $('panel').classList.add('hidden'); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // model_20261105-154210.scad → „05.11.2026, 15:42:10“
  function fileDate(f) {
    const m = /model_(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(f || '');
    return m ? m[3] + '.' + m[2] + '.' + m[1] + ', ' + m[4] + ':' + m[5] + ':' + m[6] : f;
  }
  function showHistory(r) {
    if (!current || r.id !== current.id) return;
    const body = openPanel(T.historyTitle);
    body.appendChild(el('p', 'hint', T.historyHint));
    if (!r.list.length) { body.appendChild(el('p', 'hint', T.historyEmpty)); return; }
    const ul = el('ul');
    for (const v of r.list) {
      const li = el('li');
      li.appendChild(el('span', null, fmt(T.historyItem, { date: fileDate(v.file), lines: v.lines })));
      const b = el('button', 'restore', T.restore);
      b.addEventListener('click', safe('wiederherstellen', () => {
        saveNow(true); // aktuellen Stand vorher sichern
        send({ type: 'readHistory', id: current.id, file: v.file });
      }));
      li.appendChild(b);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  function showSettings() {
    const body = openPanel(T.settingsTitle);
    const row = (label, input) => { const l = el('label', 'row'); l.appendChild(el('span', null, label)); l.appendChild(input); body.appendChild(l); };
    const lg = el('select');
    lg.id = 'setLang';
    for (const [v, label] of [['de', 'Deutsch'], ['en', 'English']]) {
      const o = el('option', null, label);
      o.value = v;
      if (v === lang) o.selected = true;
      lg.appendChild(o);
    }
    lg.addEventListener('change', safe('Sprache', () => { saveSettings({ lang: lg.value }); setLang(lg.value, true); }));
    row(T.setLang, lg);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'setOpenLast';
    cb.checked = settings.openLast;
    cb.addEventListener('change', () => saveSettings({ openLast: cb.checked }));
    row(T.setOpenLast, cb);
    const select = (id, values, cur, key, suffix) => {
      const s = el('select');
      s.id = id;
      for (const v of values) { const o = el('option', null, v + (suffix || '')); o.value = v; if (v === cur) o.selected = true; s.appendChild(o); }
      s.addEventListener('change', () => saveSettings({ [key]: Number(s.value) }));
      return s;
    };
    const th = el('select');
    th.id = 'setTheme';
    for (const [v, label] of [['system', T.themeSystem], ['dark', T.themeDark], ['light', T.themeLight]]) {
      const o = el('option', null, label);
      o.value = v;
      if (v === (settings.theme || 'system')) o.selected = true;
      th.appendChild(o);
    }
    th.addEventListener('change', () => saveSettings({ theme: th.value }));
    row(T.setTheme, th);
    row(T.setFontSize, select('setFontSize', [12, 13, 14, 15, 16, 17, 18, 20, 22], settings.fontSize, 'fontSize', ' pt'));
    row(T.setHistoryMax, select('setHistoryMax', [5, 10, 20, 30, 50], settings.historyMax, 'historyMax'));
    body.appendChild(el('h4', null, T.updateTitle)); // 10l
    body.appendChild(el('p', 'hint', fmt(T.updateInstalled, { v: APP_VERSION })));
    const ub = el('button', null, T.updateCheck);
    ub.id = 'btnUpdate';
    ub.addEventListener('click', () => { ub.disabled = true; ub.textContent = T.updateChecking; send({ type: 'checkUpdate' }); });
    body.appendChild(ub);
    body.appendChild(el('h4', null, T.shortcutsTitle));
    body.appendChild(el('p', 'hint', T.shortcuts));
    // 10o: Über & Lizenzen (Texte + Liste in about.js, gemeinsam mit dem Slicer)
    const at = ScriptSCADAbout.text(lang);
    body.appendChild(el('h4', null, at.title));
    const ab = el('button', null, at.open);
    ab.id = 'btnAbout';
    ab.addEventListener('click', safe('Über', showAbout));
    body.appendChild(ab);
    body.appendChild(ScriptSCADAbout.donateBlock(lang, openDonate)); // 10p: Spenden-Button
  }
  function openDonate(url) { send({ type: 'openUrl', url }); }
  function showAbout() {
    const body = openPanel(ScriptSCADAbout.text(lang).title);
    ScriptSCADAbout.render(body, lang, 'studio', APP_VERSION, openDonate);
    body.scrollTop = 0;
  }
  // 10l: Ergebnis der Update-Prüfung
  async function updateResult(r) {
    const b = $('btnUpdate');
    if (b) { b.disabled = false; b.textContent = T.updateCheck; }
    if (r.state === 'newer') {
      const go = await dialog({ title: fmt(T.updateNewerTitle, { v: r.version }), text: fmt(T.updateNewerText, { cur: r.current, v: r.version, notes: r.notes || '–' }), okText: T.updateDownload });
      if (go) { toast(T.updateLoading); send({ type: 'downloadUpdate' }); }
      return;
    }
    const text = r.state === 'current' ? fmt(T.updateCurrent, { v: r.current }) : r.state === 'noSource' ? T.updateNoSource : fmt(T.updateError, { msg: r.msg });
    await dialog({ title: T.updateTitle, text, noCancel: true });
  }
  async function updateDownloaded(r) {
    if (!r.ok) { await dialog({ title: T.updateTitle, text: fmt(T.updateError, { msg: r.msg }), noCancel: true }); return; }
    const c = await dialog({ title: fmt(T.updateLoadedTitle, { v: r.version }), text: fmt(T.updateLoadedText, { rel: r.rel }),
      buttons: [{ id: 'dlgClose', label: T.close, value: null }, { id: 'dlgFiles', label: T.saveToFiles, value: 'files', cls: 'primary' }] });
    if (c === 'files') send({ type: 'saveUpdateToFiles', path: r.path });
  }
  function saveSettings(change) {
    Object.assign(settings, change);
    applySettings();
    send({ type: 'settings', settings: change });
  }

  // ---------- Schnittstelle für Scriptable ----------
  let rafCount = 0;
  (function frames() { rafCount++; requestAnimationFrame(frames); })();
  function diag() {
    return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, vis: document.visibilityState, frames: rafCount };
  }

  window.App = {
    version: () => APP_VERSION,
    setLang: (l) => { try { setLang(l, true); } catch (e) { logError('setLang', e); } return lang; },
    ready: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r('ready'), 50)))),
    diag: () => JSON.stringify(diag()),
    poll: (ack) => {
      ack = Number(ack) || 0;
      while (queue.length && queue[0]._id <= ack) queue.shift();
      return JSON.stringify({ actions: queue.slice(), diag: diag() });
    },
    fontAdd,
    partsBegin, partAdd, partsDone, partsAdded: (j) => { try { partsAdded(j); } catch (e) { logError('partsAdded', e); } },
    fontsDone,
    libAdd,
    libDone,
    setScadLib: (json) => { try { scadLib = JSON.parse(json); log('Bibliothek: ' + Object.keys(scadLib).join(', ')); } catch (e) { logError('setScadLib', e); } },
    setVersion: (v) => {
      log('Version ' + v + ' (Oberfläche ' + APP_VERSION + ')');
      if (v !== APP_VERSION) {
        const msg = fmt(T.versionMismatch, { a: v, b: APP_VERSION });
        log(msg);
        dialog({ title: T.appName, text: msg, noCancel: true });
      }
    },
    setProjects: (json) => {
      try {
        projects = JSON.parse(json);
        renderList();
      } catch (e) { logError('setProjects', e); }
    },
    openProject: (json) => {
      try {
        current = JSON.parse(json);
        savedCode = current.code;
        lastSnapCode = current.code;
        lastStl = null;
        lastStlCode = null;
        lastRenderCode = null;
        slowModel = false;
        pendingRender = null;
        paramSig = null;
        collapsed = new Set(Array.isArray(current.collapsed) ? current.collapsed : []);
        selectedObj = null;
        objSig = null;
        presets = P.cleanPresets(current.presets);
        pickCode = null;
        viewer.setPickParts([]);
        viewer.showHighlight(null);
        aiPreview = null;
        lastRun = null;
        $('btnRepair').classList.add('hidden');
        viewer.setCompare(null);
        $('view').classList.remove('comparing');
        aiBusy = false;
        aiHistory = [];
        endSketch(false);
        aiSketch = null;
        aiFiles = [];
        send({ type: 'aiClearFiles' });
        buildAiPane();
        editor.setCode(current.code);
        lastMsgs = [];
        showConsole([]);
        showScreen('project');
        updateDirty();
        refreshParams(false);
        render().catch((e) => { status(fmt(T.error, { msg: e.message }), true); logError('render', e); });
      } catch (e) { logError('openProject', e); }
    },
    // Scriptable bestätigt das Speichern
    saved: (json) => {
      try {
        const r = JSON.parse(json);
        const code = pendingSaves[r.seq];
        delete pendingSaves[r.seq];
        if (!r.ok) toast(fmt(T.saveFailed, { msg: r.error }));
        if (current && r.id === current.id && code != null) {
          if (r.ok) savedCode = code;
          updateDirty();
        }
      } catch (e) { logError('saved', e); }
    },
    // Scriptable wartet auf ai/response.txt (wurde vor dem Ende des Kurzbefehls zurückgeholt)
    aiBackgroundWait: (min, text, diag) => {
      try {
        const st = $('aiState');
        st.textContent = '';
        const p = el('p', 'aiWait', text || fmt(T.aiBackgroundWait, { min }));
        const b = el('button', null, T.aiWaitCancel);
        b.id = 'aiWaitCancel';
        b.addEventListener('click', () => { aiCancel = true; b.disabled = true; b.textContent = T.aiWaitCancelling; });
        st.append(p);
        if (diag) st.append(el('p', 'aiDiag', diag));
        st.append(b);
        b.scrollIntoView({ block: 'nearest' });
        status(text || fmt(T.aiBackgroundWait, { min }));
      } catch (e) { logError('aiBackgroundWait', e); }
    },
    aiCancelState: () => String(aiCancel),
    setDeviceDark: (on) => {
      try {
        deviceDark = !!on;
        send({ type: 'log', text: 'Darstellung: iPad ' + (deviceDark ? 'dunkel' : 'hell') + ', WebView ' + (darkQuery ? (darkQuery.matches ? 'dunkel' : 'hell') : 'unbekannt') + ', Einstellung ' + (settings.theme || 'system') + ' → ' + effectiveTheme() });
        applyTheme();
      } catch (e) { logError('setDeviceDark', e); }
    },
    setSettings: (json) => {
      try {
        settings = JSON.parse(json);
        setLang(settings.lang || settings.sysLang || 'de', true);
        applySettings();
        if ($('aiAgent') && settings.aiAgent) { $('aiAgent').value = settings.aiAgent; if ($('aiAgent')._sync) $('aiAgent')._sync(); }
      } catch (e) { logError('setSettings', e); }
    },
    aiFiles: (json) => {
      try {
        const r = JSON.parse(json);
        aiFiles = aiFiles.concat(r.files || []);
        renderAttachments();
        showPane('ai');
        if (r.problems && r.problems.length) toast(r.problems.join('\n'));
      } catch (e) { logError('aiFiles', e); }
    },
    // Einfügen aus der Zwischenablage: ganzen Code ersetzen (rückgängig machbar, alter Stand als Version)
    pasteCode: (json) => {
      try {
        const r = JSON.parse(json);
        saveNow(true);
        editor.replaceAll(r.code);
        updateDirty();
        refreshParams(false);
        saveNow(true);
        toast(r.extracted ? T.pastedExtracted : T.pasted);
        requestRender();
      } catch (e) { logError('pasteCode', e); }
    },
    aiCopied: (json) => { try { aiCopied(JSON.parse(json)); } catch (e) { logError('aiCopied', e); } },
    aiResult: (json) => { try { aiResult(JSON.parse(json)); } catch (e) { logError('aiResult', e); } },
    setAiHistory: (json) => {
      try {
        const r = JSON.parse(json);
        if (current && r.id === current.id) { aiHistory = r.list || []; renderAiHistory(); }
      } catch (e) { logError('setAiHistory', e); }
    },
    showHistory: (json) => { try { showHistory(JSON.parse(json)); } catch (e) { logError('showHistory', e); } },
    restoreVersion: (json) => {
      try {
        const r = JSON.parse(json);
        if (!current || r.id !== current.id) return;
        closePanel();
        editor.replaceAll(r.code);
        updateDirty();
        toast(fmt(T.restored, { date: fileDate(r.file) }));
        render().catch((e) => logError('render', e));
      } catch (e) { logError('restoreVersion', e); }
    },
    // Scriptable hat die STL-Datei geschrieben → fragen, wie weitergeben
    // 10k: mehrere/andere Dateien gespeichert → teilen oder (eine Datei) in Dateien sichern
    filesSaved: (json) => {
      try {
        const r = JSON.parse(json);
        dialog({
          title: T.filesSavedTitle,
          text: fmt(T.filesSavedText, { list: r.files.map((f) => 'projects/' + r.folder + '/export/' + f).join('\n') }),
          buttons: [
            { id: 'dlgClose', label: T.close, value: null },
            ...(r.paths.length === 1 ? [{ id: 'dlgFiles', label: T.saveToFiles, value: 'files' }] : []),
            { id: 'dlgShare', label: T.share, value: 'share', cls: 'primary' },
          ],
        }).then((choice) => {
          if (choice === 'share') send({ type: 'share', paths: r.paths });
          if (choice === 'files') send({ type: 'saveToFiles', path: r.paths[0] });
        });
      } catch (e) { logError('filesSaved', e); }
    },
    updateResult: (j) => { updateResult(JSON.parse(j)).catch((e) => logError('updateResult', e)); },
    updateDownloaded: (j) => { updateDownloaded(JSON.parse(j)).catch((e) => logError('updateDownloaded', e)); },
    stlSaved: (json) => {
      try {
        const r = JSON.parse(json);
        dialog({
          title: T.stlSavedTitle,
          text: fmt(T.stlSavedText, { id: r.id, file: r.file }),
          buttons: [
            { id: 'dlgClose', label: T.close, value: null },
            { id: 'dlgFiles', label: T.saveToFiles, value: 'files' },
            { id: 'dlgShare', label: T.share, value: 'share', cls: 'primary' },
          ],
        }).then((choice) => {
          if (choice === 'share') send({ type: 'share', path: r.path });
          if (choice === 'files') send({ type: 'saveToFiles', path: r.path });
        });
      } catch (e) { logError('stlSaved', e); }
    },
    wasmBegin,
    wasmAdd,
    wasmFinish: () => wasmFinish().catch((e) => { logError('wasmFinish', e); status(fmt(T.error, { msg: e.message }), true); return JSON.stringify({ error: e.message }); }),
    toast,
    status,
    log,
    getLog: () => $('log').textContent,
    _viewer: () => viewer, // nur für Tests
    _editor: () => editor, // nur für Tests
    _simSafeTop: (px) => { document.documentElement.style.setProperty('--safeTop', px + 'px'); updateNavMode(); return navMode; }, // nur Container-Tests
    _state: () => JSON.stringify({ navMode, toolsScroll: (() => { const t = document.querySelector('header .tools'); return { sw: t.scrollWidth, cw: t.clientWidth, fadeR: t.classList.contains('fadeR') }; })(), consoleOpen, histOpen: !!$('aiHistory') && !$('aiHistory').classList.contains('hidden'), agent: $('aiAgent') ? $('aiAgent').value : null, theme: document.documentElement.dataset.theme, themeSetting: settings.theme, statusIn: $('status').parentNode.id, screen: current && !$('screenProject').classList.contains('hidden') ? 'project' : 'list', rendering, wasm: !!wasmModule, pane, viewMode: settings.viewMode, split: splitPct(), slowModel, sel: selectedObj, aiBusy, aiPreview: !!aiPreview, comparing: viewer.isComparing(), sketching, aiSketch: !!aiSketch, aiFiles: aiFiles.map((f) => f.name) }),
  };

  // ---------- Start ----------
  try {
    applyTexts();
    editor = window.SCADEditor.createEditor($('editor'), {
      onChange: onEdit,
      onRun: () => { requestRender(); },
      onSave: () => saveNow(true),
    });
    applyTheme(); // sofort (vor den gespeicherten Einstellungen) nach System-Darstellung
    applySettings();
    $('btnBack').addEventListener('click', safe('zurück', () => {
      endSketch(false);
      saveNow(true);
      editor.blur();
      closePanel();
      current = null;
      showScreen('list');
      status(wasmModule ? T.openscadReady : '');
      send({ type: 'list' });
    }));
    const logPanel = LogPanel({ button: $('btnLog') }); // 9i.2: mit Trennbalken (Höhe ziehen)
    $('btnLog').addEventListener('click', () => logPanel.toggle());
    $('modeEdit').addEventListener('click', safe('Ansicht', () => setViewMode('edit')));
    $('modeBoth').addEventListener('click', safe('Ansicht', () => setViewMode('both')));
    $('modeView').addEventListener('click', safe('Ansicht', () => { editor.blur(); setViewMode('view'); }));
    initSplitter();
    $('tabCode').addEventListener('click', safe('Code', () => showPane('code')));
    $('tabParams').addEventListener('click', safe('Regler', () => showPane('params')));
    $('tabAi').addEventListener('click', safe('KI', () => showPane('ai')));
    buildAiPane();
    // Rückgängig/Wiederholen: danach sofort neu rendern (wie beim Regler: keine Version, Kamera bleibt)
    const undoRedo = (redo) => { if (redo) editor.redo(); else editor.undo(); updateDirty(); requestRender({ param: true }); };
    $('btnUndo').addEventListener('click', safe('rückgängig', () => undoRedo(false)));
    $('btnCopy').addEventListener('click', safe('kopieren', () => send({ type: 'copyCode', code: editor.getCode() })));
    $('btnPaste').addEventListener('click', safe('einfügen', () => { if (aiPreview) endPreview(false, true); send({ type: 'pasteCode' }); }));
    $('btnRedo').addEventListener('click', safe('wiederholen', () => undoRedo(true)));
    $('btnRender').addEventListener('click', safe('rendern', () => { editor.blur(); return requestRender(); }));
    $('btnStl').addEventListener('click', safe('STL', exportMenu)); // 10k: erst Format wählen
    $('btnSlicer').addEventListener('click', safe('Slicer', openSlicer));
    $('btnPart').addEventListener('click', safe('Teil', addPart));
    $('btnSection').addEventListener('click', safe('Schnitt', () => setSection(section ? null : { axis: 'z', t: 0.5, flip: false })));
    $('btnViewPhoto').addEventListener('click', safe('Fotos', () => send({ type: 'saveViewToPhotos', image: composeView(false) })));
    $('btnRepair').addEventListener('click', safe('Reparatur', (e) => { e.stopPropagation(); return repairNow(); }));
    $('consoleHead').addEventListener('click', () => setConsoleOpen(!consoleOpen));
    $('aiHistTitle').textContent = T.aiHistoryTitle;
    $('aiHistFold').addEventListener('click', () => {
      const open = $('aiHistory').classList.contains('hidden');
      $('aiHistory').classList.toggle('hidden', !open);
      $('histPane').classList.toggle('open', open);
      $('aiHistFold').classList.toggle('open', open);
      $('aiHistFold').setAttribute('aria-expanded', String(open));
    });
    $('consoleHead').addEventListener('keydown', (e) => { if (e.target === $('consoleHead') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setConsoleOpen(!consoleOpen); } });
    $('btnHistory').addEventListener('click', safe('Versionen', () => { saveNow(true); send({ type: 'listHistory', id: current.id }); }));
    $('btnSettings').addEventListener('click', safe('Einstellungen', showSettings));
    $('panelClose').addEventListener('click', closePanel);
    // Hardware-Tastatur außerhalb des Editors: ⌘/Strg + Enter = Rendern, ⌘/Strg + S = Speichern
    document.addEventListener('keydown', (e) => {
      if (!current || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
      if (e.key === 'Enter') { e.preventDefault(); requestRender(); }
      if (e.key === '1') { e.preventDefault(); showPane('code'); editor.focus(); }
      if (e.key === '2') { e.preventDefault(); showPane('params'); }
      if (e.key === '3') { e.preventDefault(); showPane('ai'); setTimeout(() => $('aiPrompt').focus(), 0); }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); saveNow(true); }
      // In der Regler-Ansicht (nicht beim Eintippen): ⌘Z / ⇧⌘Z = Rückgängig/Wiederholen mit sofortigem Rendern
      const inField = e.target && e.target.closest && e.target.closest('input, select, textarea, .cm-editor');
      if (pane === 'params' && !inField && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoRedo(e.shiftKey); }
    });
    $('btnNew').addEventListener('click', safe('neu', async () => {
      const name = await dialog({ title: T.newProjectTitle, input: T.newProjectDefault, okText: T.create });
      if (name) send({ type: 'create', name });
    }));
    $('dlgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') dialogPress(true); });
    viewer = window.SCADViewer.createViewer($('view'));
    viewer.onTap((ndc) => { tapView(ndc).catch((e) => { picking = false; logError('Antippen', e); }); });
    shownTheme = null;
    applyTheme();
    initSketchCanvas();
    initToolScroll();
    window.addEventListener('resize', updateNavMode);
    window.addEventListener('orientationchange', () => setTimeout(updateNavMode, 300));
    updateNavMode();
    // Schriften (8c) liegen lokal in app/fonts – ins Protokoll, ob sie geladen wurden (Diagnose)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
      const ok = (f) => { try { return document.fonts.check(f); } catch (e) { return false; } };
      log('Schriften: Space Grotesk ' + (ok('700 16px "Space Grotesk"') ? 'ok' : 'fehlt') + ', JetBrains Mono ' + (ok('16px "JetBrains Mono"') ? 'ok' : 'fehlt'));
    });
    setInterval(() => { $('beat').textContent = '● ' + Math.round((performance.now() - tPage) / 1000) + ' s'; }, 1000);
    log('Oberfläche ' + APP_VERSION + ' geladen.');
  } catch (e) {
    logError('Start', e);
    status(fmt(T.error, { msg: e.message }), true);
  }
})();
