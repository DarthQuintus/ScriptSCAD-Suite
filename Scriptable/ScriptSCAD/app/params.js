// Parameter-Erkennung für ScriptSCAD Studio (OpenSCAD-Customizer-Syntax).
// Läuft in der WebView (global window.SCADParams) und in Node (Tests: require/import).
// Doku der Syntax: https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer
//
// Erkannt werden Zuweisungen OBEN in der Datei (vor dem ersten Modul/Objekt), deren Wert ein Literal ist:
//   breite = 20;        // [5:100]        → Schieberegler (min:max)
//   wand = 2;           // [1:0.5:5]      → Schieberegler (min:schritt:max)
//   laenge = 30;        // [80]           → Schieberegler 0…80
//   anzahl = 3;                           → Zahlenfeld
//   tueren = 2;         // .5             → Zahlenfeld mit Schrittweite 0,5
//   form = "rund";      // [rund, eckig]  → Auswahl
//   groesse = 20;       // [10:klein, 20:mittel, 30:groß] → Auswahl mit Beschriftung
//   deckel = true;                        → Schalter
//   name = "Max";       // 8              → Textfeld (max. 8 Zeichen)
//   punkt = [1, 2, 3];                    → mehrere Zahlenfelder
// Beschreibung = Kommentarzeile direkt darüber. Gruppen: /* [Name] */, /* [Hidden] */ blendet aus.
// Variablen mit $ (z. B. $fn) werden nicht als Regler angeboten.
(function (g) {
  'use strict';

  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const STR = '"(?:[^"\\\\]|\\\\.)*"';
  const VEC = '\\[\\s*(?:' + NUM + '(?:\\s*,\\s*' + NUM + ')*)?\\s*\\]';
  const VALUE = '(?:' + NUM + '|' + STR + '|true|false|' + VEC + ')';
  // Zeile: name = Wert; // Kommentar
  const ASSIGN_RE = new RegExp('^(\\s*)([A-Za-z_$][A-Za-z0-9_]*)(\\s*=\\s*)(' + VALUE + ')(\\s*;)\\s*(?://(.*))?$');
  const ANY_ASSIGN_RE = /^\s*[A-Za-z_$][A-Za-z0-9_]*\s*=/;
  const GROUP_RE = /^\s*\/\*\s*\[([^\]]*)\]\s*\*\/\s*$/;
  const NUM_RE = new RegExp('^' + NUM + '$');

  function unquote(s) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  function quote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
  }
  function decimals(x) {
    const s = String(x);
    if (/e/i.test(s)) {
      const m = /^[-+]?\d*\.?(\d*)e([-+]?\d+)$/i.exec(s);
      return m ? Math.max(0, m[1].length - Number(m[2])) : 0;
    }
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function literal(src) {
    if (src === 'true') return { type: 'bool', value: true };
    if (src === 'false') return { type: 'bool', value: false };
    if (src[0] === '"') return { type: 'string', value: unquote(src) };
    if (src[0] === '[') {
      const inner = src.slice(1, -1).trim();
      return { type: 'vector', value: inner ? inner.split(',').map((x) => Number(x.trim())) : [] };
    }
    return { type: 'number', value: Number(src) };
  }

  // Kommentar-Text hinter dem Wert → Bedienelement
  function widget(lit, comment, valueSrc) {
    const c = (comment || '').trim();
    const m = /^\[(.*)\]/.exec(c);
    if (m && lit.type !== 'bool' && lit.type !== 'vector') {
      const inner = m[1].trim();
      if (inner.includes(',')) {
        // Auswahl: [a, b, c] oder [wert:Beschriftung, …]
        const options = inner.split(',').map((part) => {
          const p = part.trim();
          const k = p.indexOf(':');
          const raw = (k >= 0 ? p.slice(0, k) : p).trim();
          const label = (k >= 0 ? p.slice(k + 1) : p).trim();
          const rawVal = raw.length > 1 && raw[0] === '"' && raw[raw.length - 1] === '"' ? unquote(raw) : raw;
          const value = lit.type === 'number' ? Number(rawVal) : rawVal;
          return { value, label: label.replace(/^"(.*)"$/, '$1') };
        }).filter((o) => o.label !== '' && !(lit.type === 'number' && Number.isNaN(o.value)));
        if (options.length) return { kind: 'select', options };
      } else if (lit.type === 'number') {
        const parts = inner.split(':').map((x) => x.trim());
        if (parts.every((x) => NUM_RE.test(x))) {
          const n = parts.map(Number);
          let min, max, step;
          if (n.length === 1) { min = 0; max = n[0]; }
          else if (n.length === 2) { min = n[0]; max = n[1]; }
          else if (n.length === 3) { min = n[0]; step = n[1]; max = n[2]; }
          if (min !== undefined && max > min) {
            if (!(step > 0)) {
              const d = Math.max(decimals(parts[0]), decimals(parts[parts.length - 1]), decimals(valueSrc));
              step = d ? Math.pow(10, -Math.min(d, 6)) : 1;
            }
            return { kind: 'slider', min, max, step };
          }
        }
      }
    }
    if (lit.type === 'bool') return { kind: 'switch' };
    if (lit.type === 'vector') {
      // Vektor: optional gemeinsamer Bereich für alle Werte, z. B. // [0:100] oder // [0:0.5:10]
      const vr = m ? m[1].split(':').map((x) => x.trim()) : null;
      if (vr && vr.length >= 1 && vr.length <= 3 && vr.every((x) => NUM_RE.test(x))) {
        const n = vr.map(Number);
        const min = n.length === 1 ? 0 : n[0];
        const max = n[n.length - 1];
        let step = n.length === 3 ? n[1] : 0;
        if (!(step > 0)) {
          const d = Math.max(decimals(vr[0]), decimals(vr[vr.length - 1]), ...lit.value.map(decimals));
          step = d ? Math.pow(10, -Math.min(d, 6)) : 1;
        }
        if (max > min) return { kind: 'vector', min, max, step };
      }
      const d = Math.max(0, ...lit.value.map(decimals));
      return { kind: 'vector', step: d ? Math.pow(10, -Math.min(d, 6)) : 1 };
    }
    if (lit.type === 'string') {
      const len = /^(\d+)\s*$/.exec(c);
      return { kind: 'text', maxLength: len ? Number(len[1]) : null };
    }
    // Zahl ohne Bereich: Zahlenfeld, „// 0.5“ = Schrittweite
    const st = /^([-+]?(?:\d+\.?\d*|\.\d+))\s*$/.exec(c);
    const step = st && Number(st[1]) > 0 ? Number(st[1]) : decimals(valueSrc) ? Math.pow(10, -Math.min(decimals(valueSrc), 6)) : 1;
    return { kind: 'number', step };
  }

  // Liefert { params: [...], end: Zeilennummer (1-basiert), wo der Parameterbereich endet }
  function parse(code) {
    const lines = String(code).split('\n');
    const params = [];
    let offset = 0; // Zeichen-Position des Zeilenanfangs
    let group = '';
    let hidden = false;
    let inBlock = false;
    let pendingAssign = false; // mehrzeilige Zuweisung (ohne Regler) überspringen
    let lastComment = null; // { line, text } letzte reine Kommentarzeile
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = offset;
      offset += line.length + 1;
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        lastComment = null;
        continue;
      }
      if (pendingAssign) {
        if (/;\s*(\/\/.*)?$/.test(line)) pendingAssign = false;
        lastComment = null;
        continue;
      }
      if (trimmed === '') { lastComment = null; continue; }
      const gm = GROUP_RE.exec(line);
      if (gm) {
        group = gm[1].trim();
        hidden = /^hidden$/i.test(group);
        lastComment = null;
        continue;
      }
      if (trimmed.startsWith('//')) { lastComment = { line: i, text: trimmed.replace(/^\/\/+\s?/, '').trim() }; continue; }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/', 2)) inBlock = true;
        lastComment = null;
        continue;
      }
      if (/^(include|use)\s*</.test(trimmed)) { lastComment = null; continue; }
      const m = ASSIGN_RE.exec(line);
      if (m) {
        const [, indent, name, eq, valueSrc, , comment] = m;
        const lit = literal(valueSrc);
        const from = start + indent.length + name.length + eq.length;
        const desc = lastComment && lastComment.line === i - 1 ? lastComment.text : '';
        lastComment = null;
        if (name[0] === '$' || hidden) continue;
        params.push(Object.assign({
          name,
          line: i + 1,
          from,
          to: from + valueSrc.length,
          source: valueSrc,
          group,
          description: desc,
          comment: comment == null ? '' : comment.trim(),
          widget: widget(lit, comment, valueSrc),
        }, lit));
        continue;
      }
      if (ANY_ASSIGN_RE.test(line)) {
        // Zuweisung mit Ausdruck (z. B. innen = breite - 2 * wand;) → kein Regler, weitersuchen
        if (!/;\s*(\/\/.*)?$/.test(line)) pendingAssign = true;
        lastComment = null;
        continue;
      }
      end = i + 1; // erstes Modul/Objekt → Parameterbereich zu Ende
      break;
    }
    return { params, end };
  }

  // Zahl so schreiben, dass sie zur Schrittweite passt (keine 0.30000000000000004)
  function formatNumber(x, step) {
    const d = Math.min(Math.max(decimals(step || 1), 0), 6);
    let s = Number(x).toFixed(d);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  // Prüft/normalisiert eine Eingabe. Ergebnis: { ok, value, text, error }
  // error: 'nan' | 'option' | 'length'
  // Bereiche aus der Customizer-Syntax (// [min:max]) begrenzen NICHT (Wunsch Nutzer 7d) – nur die Schrittweite zählt.
  function validate(param, input) {
    const w = param.widget;
    if (param.type === 'bool') {
      const v = input === true || input === 'true';
      return { ok: true, value: v, text: v ? 'true' : 'false' };
    }
    if (param.type === 'number') {
      const n = typeof input === 'number' ? input : Number(String(input).trim().replace(',', '.'));
      if (String(input).trim() === '' || !Number.isFinite(n)) return { ok: false, error: 'nan' };
      if (w.kind === 'select' && !w.options.some((o) => o.value === n)) return { ok: false, error: 'option' };
      const text = formatNumber(n, w.step || (w.kind === 'select' ? Math.pow(10, -Math.min(decimals(n), 6)) : 1));
      return { ok: true, value: Number(text), text };
    }
    if (param.type === 'string') {
      const s = String(input);
      if (w.kind === 'select' && !w.options.some((o) => o.value === s)) return { ok: false, error: 'option' };
      if (w.kind === 'text' && w.maxLength && s.length > w.maxLength) return { ok: false, error: 'length' };
      return { ok: true, value: s, text: quote(s) };
    }
    if (param.type === 'vector') {
      const arr = Array.isArray(input) ? input : null;
      if (!arr || !arr.every((x) => Number.isFinite(Number(String(x).replace(',', '.'))))) return { ok: false, error: 'nan' };
      if (arr.some((x) => String(x).trim() === '')) return { ok: false, error: 'nan' };
      const nums = arr.map((x) => Number(String(x).replace(',', '.')));
      const texts = nums.map((x) => formatNumber(x, w.min !== undefined ? w.step : 1e-6));
      return { ok: true, value: texts.map(Number), text: '[' + texts.join(', ') + ']' };
    }
    return { ok: false, error: 'nan' };
  }

  // Neuer Code mit geändertem Wert (nur der Wert wird ersetzt). Ergebnis: { ok, code, change: {from, to, insert} } oder { ok:false, error }
  function setValue(code, param, input) {
    const v = validate(param, input);
    if (!v.ok) return v;
    if (String(code).slice(param.from, param.to) !== param.source) return { ok: false, error: 'stale' };
    const change = { from: param.from, to: param.to, insert: v.text };
    return { ok: true, value: v.value, text: v.text, change, code: code.slice(0, param.from) + v.text + code.slice(param.to) };
  }

  // Kurzbeschreibung der Struktur: ändert sie sich, muss die Regler-Ansicht neu aufgebaut werden
  function signature(params) {
    return params.map((p) => [p.name, p.type, p.group, p.description, p.comment, p.type === 'vector' ? p.value.length : ''].join('\u0001')).join('\u0002');
  }

  // ---------- Vorlagen (7h): Parametersätze im Format des OpenSCAD-Customizers ----------
  // Datei model.json neben model.scad: { "parameterSets": { "Name": { "breite": "40", … } }, "fileFormatVersion": "1" }
  // Werte stehen (wie bei OpenSCAD) als Text: Zahl/true/false/Vektor wie im Code, Text ohne Anführungszeichen.
  function presetValues(params) {
    const out = {};
    for (const p of params) out[p.name] = p.type === 'string' ? String(p.value) : p.source.trim();
    return out;
  }
  function presetInput(param, raw) {
    if (param.type === 'bool') {
      const t = String(raw).trim().toLowerCase();
      return t === 'true' || t === 'false' ? t === 'true' : undefined;
    }
    if (param.type === 'vector') {
      if (Array.isArray(raw)) return raw;
      const m = /^\s*\[([^\]]*)\]\s*$/.exec(String(raw));
      return m ? m[1].split(',').map((x) => x.trim()) : undefined;
    }
    if (param.type === 'string') return String(raw);
    return raw;
  }
  // Vorlage anwenden → { changes, applied: [Namen], skipped: [Namen] } (Änderungen in Positionen von code, gemeinsam anwenden)
  function applyPreset(code, set) {
    const { params } = parse(code);
    const changes = [];
    const applied = [];
    const skipped = [];
    for (const [name, raw] of Object.entries(set || {})) {
      const p = params.find((x) => x.name === name);
      if (!p) { skipped.push(name); continue; }
      const input = presetInput(p, raw);
      const v = input === undefined ? { ok: false } : validate(p, input);
      if (!v.ok) { skipped.push(name); continue; }
      applied.push(name);
      if (v.text !== p.source.trim()) changes.push({ from: p.from, to: p.to, insert: v.text });
    }
    return { changes, applied, skipped };
  }
  // Gelesene model.json prüfen → { name: { param: wert } } (Unbrauchbares wird verworfen)
  function cleanPresets(json) {
    const sets = json && typeof json === 'object' && json.parameterSets && typeof json.parameterSets === 'object' ? json.parameterSets : {};
    const out = {};
    for (const [name, set] of Object.entries(sets)) {
      if (!set || typeof set !== 'object' || Array.isArray(set)) continue;
      const clean = {};
      for (const [k, v] of Object.entries(set)) if (/^[A-Za-z_]\w*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v)) clean[k] = v;
      out[String(name).slice(0, 100)] = clean;
    }
    return out;
  }

  const api = { parse, setValue, validate, formatNumber, signature, presetValues, applyPreset, cleanPresets };
  g.SCADParams = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
