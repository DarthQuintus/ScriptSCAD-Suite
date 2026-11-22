// ScriptSCAD – gemeinsames Einstellungsfenster für Studio (app.js) und Slicer (slicer.js), seit 10p.3. Global "ScriptSCADSettings".
// Aufbau (Wunsch Nutzer 2026-11-22, in beiden Apps gleich): oben die Auswahl (Knopfreihen), darunter
//   1. Spenden (about.js → donateBlock)  2. Updates  3. Über & Lizenzen  4. Tastenkürzel, unten „Schließen“.
// Das Fenster wird bei jeder Änderung neu aufgebaut (open erneut aufrufen) – so stimmen Texte und Auswahl immer.
(function (root) {
  'use strict';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let onClose = null;
  function dialog() {
    let d = document.getElementById('setDialog');
    if (!d) {
      d = el('div'); d.id = 'setDialog'; d.className = 'hidden';
      document.body.appendChild(d);
      d.addEventListener('click', (e) => { if (e.target === d) close(); });
    }
    return d;
  }
  // o = { title, closeLabel, groups: [{ id, label, options: [[wert, text]], cur, pick }], note,
  //       donate: { lang, onOpen }, update: { title, text, button, onCheck }, about: { title, button, onOpen }, shortcuts: { title, text }, onClose }
  function open(o) {
    const d = dialog();
    const keep = document.getElementById('setBox') && !d.classList.contains('hidden') ? document.getElementById('setBox').scrollTop : 0;
    d.textContent = '';
    onClose = o.onClose || null;
    const box = el('div'); box.id = 'setBox'; box.setAttribute('role', 'dialog');
    box.appendChild(el('h3', null, o.title));
    for (const g of o.groups || []) {
      const grp = el('div', 'setGroup'); grp.id = g.id;
      grp.appendChild(el('span', 'lbl', g.label));
      const segs = el('span', 'segs');
      for (const [val, text] of g.options) {
        const b = el('button', null, text);
        b.dataset.val = String(val);
        b.classList.toggle('on', String(val) === String(g.cur));
        b.addEventListener('click', () => g.pick(val));
        segs.appendChild(b);
      }
      grp.appendChild(segs);
      box.appendChild(grp);
      if (g.note) box.appendChild(el('p', 'note', g.note));
    }
    if (o.note) box.appendChild(el('p', 'note', o.note));
    // 1. Spenden
    if (o.donate && root.ScriptSCADAbout) box.appendChild(root.ScriptSCADAbout.donateBlock(o.donate.lang, o.donate.onOpen));
    // 2. Updates
    if (o.update) {
      const s = el('div', 'setSection'); s.id = 'setUpdate';
      s.appendChild(el('h4', null, o.update.title));
      s.appendChild(el('p', 'note', o.update.text));
      const b = el('button', null, o.update.button); b.id = 'btnUpdate';
      b.addEventListener('click', () => { b.disabled = true; if (o.update.busy) b.textContent = o.update.busy; o.update.onCheck(); });
      s.appendChild(b);
      box.appendChild(s);
    }
    // 3. Über & Lizenzen
    if (o.about) {
      const s = el('div', 'setSection'); s.id = 'setAbout';
      s.appendChild(el('h4', null, o.about.title));
      const b = el('button', null, o.about.button); b.id = 'btnAbout';
      b.addEventListener('click', o.about.onOpen);
      s.appendChild(b);
      box.appendChild(s);
    }
    // 4. Tastenkürzel
    if (o.shortcuts) {
      const s = el('div', 'setSection'); s.id = 'setKeys';
      s.appendChild(el('h4', null, o.shortcuts.title));
      s.appendChild(el('p', 'note', o.shortcuts.text));
      box.appendChild(s);
    }
    const foot = el('div', 'foot');
    const c = el('button', 'primary', o.closeLabel); c.id = 'btnSetClose';
    c.addEventListener('click', close);
    foot.appendChild(c);
    box.appendChild(foot);
    d.appendChild(box);
    d.classList.remove('hidden');
    box.scrollTop = keep;
    return box;
  }
  // „Über & Lizenzen“ im selben Fenster: render(box) füllt den Inhalt; unten „‹ Einstellungen“ und „Schließen“
  function showAbout(o) {
    const box = document.getElementById('setBox');
    if (!box) return null;
    box.textContent = '';
    box.appendChild(el('h3', null, o.title));
    o.render(box);
    const foot = el('div', 'foot');
    const back = el('button', null, '‹ ' + o.backLabel); back.id = 'btnAboutBack'; back.addEventListener('click', o.onBack);
    const c = el('button', 'primary', o.closeLabel); c.id = 'btnAboutClose'; c.addEventListener('click', close);
    foot.appendChild(back); foot.appendChild(c); box.appendChild(foot);
    box.scrollTop = 0;
    return box;
  }
  function close() {
    const d = document.getElementById('setDialog');
    if (d && !d.classList.contains('hidden')) { d.classList.add('hidden'); if (onClose) onClose(); }
  }
  const isOpen = () => { const d = document.getElementById('setDialog'); return !!d && !d.classList.contains('hidden'); };
  // Update-Knopf nach der Prüfung wieder freigeben
  function updateDone(label) { const b = document.getElementById('btnUpdate'); if (b) { b.disabled = false; b.textContent = label; } }
  root.ScriptSCADSettings = { open, showAbout, close, isOpen, updateDone };
})(typeof window !== 'undefined' ? window : globalThis);
