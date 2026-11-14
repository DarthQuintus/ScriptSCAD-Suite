// ScriptSCAD – gemeinsame Oberflächen-Bausteine für Studio (app.js) und Slicer (slicer.js), seit 10b. Global "UICommon" (+ "LogPanel").
// Enthält: Symbol-Helfer (svg, iconButton), Innenmaße (contentRect), Abstand oben (safeTop, für die Titel-Leiste von Scriptable),
// Trennbalken links/rechts bzw. oben/unten (splitter), Protokoll mit Trennbalken (LogPanel, 9i.2).
(function (root) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Linien-Symbol (24×24, Farbe = Textfarbe)
  const svg = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  // Knopf mit Symbol; label = sichtbarer Text (optional), title = Beschriftung beim langen Drücken / für VoiceOver
  function iconButton(id, icon, title, label) {
    const b = typeof id === 'string' ? $(id) : id;
    b.innerHTML = icon + (label ? '<span>' + label + '</span>' : '');
    b.classList.add('tb');
    b.classList.toggle('iconOnly', !label);
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  // Innenfläche (ohne Rand/padding) – darauf beziehen sich die Prozent der Aufteilung
  function contentRect(e) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0, pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    return { left: r.left + pl, top: r.top + pt, width: r.width - pl - pr, height: r.height - pt - pb };
  }
  // Sicherheitsabstand oben (Scriptable-Leiste); --safeTop = Ersatzwert für Container-Tests
  let navProbe = null;
  function safeTop() {
    if (!navProbe) {
      navProbe = document.createElement('div');
      navProbe.style.cssText = 'position:fixed;left:0;top:0;width:1px;visibility:hidden;pointer-events:none;height:var(--safeTop, env(safe-area-inset-top, 0px))';
      document.body.appendChild(navProbe);
    }
    return navProbe.offsetHeight;
  }
  // Trennbalken zwischen Bearbeitungsbereich und 3D-Ansicht: ziehen = Größe ändern, doppelt tippen = Standard, Pfeiltasten ±5 %.
  // o: { el, container, isTall(), current() → % , defaults: { wide, tall }, minPx, layout() (während des Ziehens), save(pct) }
  function splitter(o) {
    const sp = o.el;
    let drag = null, grab = 0, lastTap = 0;
    const clamp = (pct) => {
      const r = contentRect(o.container);
      const size = o.isTall() ? r.height : r.width;
      const min = size > 0 ? Math.min(45, ((o.minPx || 160) / size) * 100) : 15;
      return Math.round(Math.max(min, Math.min(100 - min, pct)));
    };
    const pctAt = (e) => { const r = contentRect(o.container); return o.isTall() ? ((e.clientY - r.top) / r.height) * 100 : ((e.clientX - r.left) / r.width) * 100; };
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastTap < 350) { lastTap = 0; o.save(o.isTall() ? o.defaults.tall : o.defaults.wide); return; } // doppelt tippen → Standard
      lastTap = now;
      try { sp.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      grab = pctAt(e) - o.current(); // Abstand Finger ↔ Balkenmitte, damit der Balken nicht springt
      drag = { pct: o.current(), id: e.pointerId, moved: false };
      sp.classList.add('active');
    });
    sp.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const p = clamp(pctAt(e) - grab);
      if (p === drag.pct) return;
      drag.pct = p; drag.moved = true;
      o.layout();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      sp.classList.remove('active');
      if (d.moved) { lastTap = 0; o.save(d.pct); }
    };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
    sp.addEventListener('dblclick', (e) => e.preventDefault());
    sp.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      o.save(clamp(o.current() + dir * 5));
    });
    return { dragging: () => (drag ? drag.pct : null), clamp };
  }
  // 9i.2: Protokoll ein-/ausblenden mit Trennbalken darüber (Studio und Slicer). Höhe in % der Fensterhöhe, gemerkt im Browser-Speicher (falls verfügbar).
  // Ziehen = Höhe ändern, doppelt tippen = Standard, Pfeiltasten ↑/↓ = ±5 %. onLayout() nach jeder Änderung (z. B. 3D-Ansicht neu zeichnen).
  const LOG_DEFAULT = 35, LOG_KEY = 'scriptscad.logPct';
  function logPanel(o) {
    const wrap = document.getElementById('logwrap'), sp = document.getElementById('logSplit'), btn = o && o.button;
    if (!wrap || !sp) return { toggle() {} };
    let pct = LOG_DEFAULT;
    try { const v = parseFloat(localStorage.getItem(LOG_KEY)); if (v >= 5 && v <= 95) pct = v; } catch (e) { /* kein Speicher – Standard */ }
    const H = () => document.documentElement.clientHeight || window.innerHeight;
    const clamp = (p) => { const h = H(); const min = Math.min(40, (80 / h) * 100), max = Math.max(min, 100 - (220 / h) * 100); return Math.max(min, Math.min(max, p)); };
    const layout = () => { if (o && o.onLayout) try { o.onLayout(); } catch (e) { /* egal */ } window.dispatchEvent(new Event('resize')); };
    const apply = () => { document.documentElement.style.setProperty('--logH', (clamp(pct) / 100 * H()).toFixed(0) + 'px'); };
    const save = () => { try { localStorage.setItem(LOG_KEY, String(Math.round(pct))); } catch (e) { /* egal */ } };
    const isOpen = () => wrap.classList.contains('open');
    function show(on) {
      wrap.classList.toggle('open', on); sp.classList.toggle('open', on);
      if (btn) btn.classList.toggle('on', on);
      apply(); layout();
    }
    let drag = null, lastTap = 0;
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastTap < 350) { lastTap = 0; pct = LOG_DEFAULT; save(); apply(); layout(); return; }
      lastTap = now;
      try { sp.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      drag = { id: e.pointerId, y: e.clientY, start: wrap.getBoundingClientRect().height, moved: false };
      sp.classList.add('active');
    });
    sp.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const p = clamp(((drag.start - (e.clientY - drag.y)) / H()) * 100);
      if (Math.abs(p - pct) < 0.2) return;
      pct = p; drag.moved = true; apply(); layout();
    });
    const end = (e) => { if (!drag || e.pointerId !== drag.id) return; const m = drag.moved; drag = null; sp.classList.remove('active'); if (m) { lastTap = 0; save(); } };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
    sp.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 5, ArrowDown: -5 }[e.key];
      if (!d) return;
      e.preventDefault(); pct = clamp(pct + d); save(); apply(); layout();
    });
    window.addEventListener('resize', () => { if (isOpen() && !drag) apply(); });
    return { toggle: () => show(!isOpen()), show, isOpen, pct: () => Math.round(clamp(pct)) };
  }

  root.UICommon = { svg, iconButton, contentRect, safeTop, splitter };
  root.LogPanel = logPanel;
})(typeof window !== 'undefined' ? window : globalThis);
