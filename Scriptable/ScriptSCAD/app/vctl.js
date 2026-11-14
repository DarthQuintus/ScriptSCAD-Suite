// ScriptSCAD – Zahlen-Bedienelement „‹ Zahl ›“ (Schritt 9d, gemeinsam für Slicer und – ab 9d.2 – Studio). Global "ValueCtl".
// ‹ / › = ein Schritt (gedrückt halten = wiederholen, wird schneller), Zahl antippen = eintippen,
// Zahl seitlich ziehen = Werte ändern (nur mit drag: true; ganze Balkenbreite = ganzer Bereich, ohne Bereich 8 px je Schritt).
// Senkrecht wischen über dem Balken scrollt die Seite (touch-action: pan-y). Slicer: drag: false (Wunsch Nutzer 2026-11-11, störte beim Scrollen).
// Hardware-Tastatur: ←/→/↑/↓ = ein Schritt, Enter/Leertaste = eintippen.
// o: { label?, value, step, min?, max?, unit?, drag? (Standard true), format(v) → Text, onInput(v) (beim Ziehen), onCommit(v | Text) → { ok, value },
//      onEnd() (nach Loslassen/Eintippen/Pfeil-Ende), onError(where, e)? }
(function (root) {
  'use strict';
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const REPEAT_DELAY = 420, REPEAT_SLOW = 90, REPEAT_FAST = 35, FAST_AFTER = 12;

  function create(o) {
    const step = o.step || 1;
    const ranged = Number.isFinite(o.min) && Number.isFinite(o.max);
    const format = o.format || ((v) => String(v));
    const safe = (where, fn) => function (e) { try { return fn.call(this, e); } catch (err) { if (o.onError) o.onError(where, err); else throw err; } };
    const wrap = mk('div', 'vctl');
    const dec = mk('button', 'varr vdec', '‹');
    const inc = mk('button', 'varr vinc', '›');
    dec.type = inc.type = 'button';
    dec.tabIndex = inc.tabIndex = -1; // Tastatur bedient den Balken selbst (←/→)
    dec.setAttribute('aria-label', '−'); inc.setAttribute('aria-label', '+');
    const bar = mk('div', 'vbar');
    const fill = mk('span', 'vfill');
    const val = mk('span', 'vval');
    bar.appendChild(fill);
    if (o.label) bar.appendChild(mk('span', 'vlabel', o.label)); else bar.classList.add('nolabel');
    bar.appendChild(val);
    if (o.unit) bar.appendChild(mk('span', 'vunit', o.unit));
    wrap.append(dec, bar, inc);
    let value = o.value;
    let active = false;
    let editing = false;
    const show = () => {
      val.textContent = format(value);
      fill.style.width = ranged ? Math.max(0, Math.min(1, (value - o.min) / (o.max - o.min))) * 100 + '%' : '0';
      dec.disabled = Number.isFinite(o.min) && value <= o.min;
      inc.disabled = Number.isFinite(o.max) && value >= o.max;
    };
    const setActive = (on) => { active = on; wrap.classList.toggle('active', on); bar.classList.toggle('active', on); };
    const snap = (v) => {
      const base = Number.isFinite(o.min) ? o.min : 0;
      v = base + Math.round((v - base) / step) * step;
      if (Number.isFinite(o.min)) v = Math.max(o.min, v);
      if (Number.isFinite(o.max)) v = Math.min(o.max, v);
      return Number(v.toFixed(6));
    };
    const commit = (v) => {
      const r = o.onCommit(v);
      if (r && r.ok) { value = typeof r.value === 'number' ? r.value : v; show(); return true; }
      return false;
    };
    show();

    // ---- Pfeile: antippen = ein Schritt, halten = wiederholen ----
    function arrow(btn, dir) {
      let timer = null, count = 0, pid = null;
      const once = () => {
        const v = snap(value + dir * step);
        if (v === value || !commit(v)) { stop(); return false; }
        return true;
      };
      const loop = () => { count++; if (!once()) return; timer = setTimeout(loop, count > FAST_AFTER ? REPEAT_FAST : REPEAT_SLOW); };
      const stop = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (pid === null) return;
        pid = null;
        setActive(false);
        if (o.onEnd) o.onEnd();
      };
      btn.addEventListener('pointerdown', safe('Pfeil', (e) => {
        if (editing || btn.disabled) return;
        e.preventDefault();
        pid = e.pointerId;
        try { btn.setPointerCapture(pid); } catch (err) { /* egal */ }
        setActive(true);
        count = 0;
        if (once()) timer = setTimeout(loop, REPEAT_DELAY);
      }));
      const up = safe('Pfeil', (e) => { if (pid === e.pointerId) stop(); });
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      // Bedienung ohne Zeiger (z. B. Bedienungshilfen): ein Schritt
      btn.addEventListener('click', safe('Pfeil', (e) => { if (e.detail === 0 && !editing) { once(); if (o.onEnd) o.onEnd(); } }));
    }
    arrow(dec, -1);
    arrow(inc, +1);

    // ---- Balken: ziehen / antippen ----
    bar.tabIndex = 0;
    const drag = o.drag !== false;
    bar.classList.toggle('nodrag', !drag);
    // Ohne Ziehen: nur antippen = eintippen (click kommt nach einem Wisch zum Scrollen nicht)
    if (!drag) {
      let p0 = null, far = false;
      bar.addEventListener('pointerdown', (e) => { p0 = [e.clientX, e.clientY]; far = false; });
      bar.addEventListener('pointermove', (e) => { if (p0 && Math.hypot(e.clientX - p0[0], e.clientY - p0[1]) > 10) far = true; });
      bar.addEventListener('click', safe('Balken', () => { if (!editing && !far) startEdit(); far = false; p0 = null; }));
    }
    let x0 = 0, v0 = 0, moved = false, pid = null;
    if (drag) bar.addEventListener('pointerdown', (e) => {
      if (editing) return;
      pid = e.pointerId;
      x0 = e.clientX; v0 = value; moved = false;
      setActive(true);
    });
    bar.addEventListener('pointermove', safe('Balken', (e) => {
      if (pid !== e.pointerId) return;
      const dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < 6) return;
      if (!moved) { try { bar.setPointerCapture(pid); } catch (err) { /* egal */ } }
      moved = true;
      const w = bar.clientWidth || 200;
      const v = snap(v0 + (ranged ? (dx / w) * (o.max - o.min) : (dx / 8) * step));
      if (v !== value) { value = v; show(); if (o.onInput) o.onInput(v); }
    }));
    const up = safe('Balken', (e) => {
      if (pid !== e.pointerId) return;
      pid = null;
      if (!moved) {
        // Abbruch = iPad hat senkrecht gescrollt → nichts tun; sonst antippen = eintippen
        if (e.type === 'pointercancel') { setActive(false); return; }
        startEdit(); return;
      }
      setActive(false);
      commit(value);
      if (o.onEnd) o.onEnd();
    });
    if (drag) { bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up); }
    bar.addEventListener('keydown', safe('Balken', (e) => {
      if (editing) return;
      if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(e.key)) {
        e.preventDefault();
        commit(snap(value + (e.key === 'ArrowUp' || e.key === 'ArrowRight' ? step : -step)));
        if (o.onEnd) o.onEnd();
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
    }));
    function startEdit() {
      setActive(true);
      editing = true;
      const inp = mk('input', 'vedit');
      inp.type = 'text';
      inp.inputMode = 'decimal';
      inp.autocomplete = 'off';
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('spellcheck', 'false');
      inp.value = format(value);
      val.replaceWith(inp);
      let done = false;
      const finish = (mode) => {
        if (done) return;
        if (mode && !commit(inp.value) && mode === 'enter') { inp.classList.add('bad'); return; }
        done = true;
        editing = false;
        inp.replaceWith(val);
        setActive(false);
        show();
        if (o.onEnd) o.onEnd();
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish('enter'); if (done) bar.focus(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); bar.focus(); }
      });
      inp.addEventListener('input', () => inp.classList.remove('bad'));
      inp.addEventListener('blur', () => finish('blur'));
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }
    return {
      el: wrap,
      bar,
      set(v) { if (active) return; value = v; show(); },
      active: () => active,
      edit: startEdit,
    };
  }
  root.ValueCtl = { create };

})(typeof window !== 'undefined' ? window : globalThis);
