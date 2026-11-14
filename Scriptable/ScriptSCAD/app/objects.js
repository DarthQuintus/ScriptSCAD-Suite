// Objekt-Erkennung für ScriptSCAD Studio: zerlegt OpenSCAD-Code in Anweisungen (Aufrufe wie cube/sphere/translate,
// Blöcke, if/for, Zuweisungen), damit der Objekt-Editor Werte einzelner Funktionen ändern und das gewählte Objekt
// in der 3D-Ansicht hervorheben kann. Läuft in der WebView (window.SCADObjects) und in Node (Tests).
//
// Begriffe:
//  - Objekt   = Aufruf einer Grundform (cube, sphere, cylinder, square, circle …) oder eines eigenen Moduls.
//  - Kette    = Transformationen direkt davor, z. B. translate([…]) rotate([…]) cube(…); → Position/Drehung des Objekts.
//  - Argument = ein Wert im Aufruf; Art: number | bool | string | variable | vector | expr (Ausdruck → nur Anzeige).
(function (g) {
  'use strict';

  // ---------- Zerlegen in Wörter (Token) ----------
  // Beschriftungen (8b): Deutsch als Standard (auch für Node-Tests), Englisch setzt die Oberfläche per setLabels(T.objLabels)
  const LABELS_DE = {
    names: { cube: 'Quader', sphere: 'Kugel', cylinder: 'Zylinder', square: 'Rechteck', circle: 'Kreis', polygon: 'Polygon',
      polyhedron: 'Polyeder', text: 'Text', import: 'Import', surface: 'Fläche',
      fase_wuerfel: 'Quader (Fase)', rund_wuerfel: 'Quader (abgerundet)', fase_zylinder: 'Zylinder (Fase)', rund_zylinder: 'Zylinder (abgerundet)' },
    width: 'Breite', depth: 'Tiefe', height: 'Höhe', edgeLen: 'Kantenlänge', centered: 'zentriert', radius: 'Radius', diameter: 'Durchmesser',
    rBottom: 'Radius unten', rTop: 'Radius oben', dBottom: 'Durchmesser unten', dTop: 'Durchmesser oben', value: 'Wert',
    quality: 'Qualität ($fn)', chamfer: 'Fase', fillet: 'Abrundung', vertOnly: 'nur senkrechte Kanten', top: 'oben', bottom: 'unten',
    errParen: 'Klammer ) fehlt', errBrace: 'Klammer } fehlt', errIncomplete: 'Anweisung unvollständig',
    errSemicolon: 'Semikolon fehlt nach {name}', errUnexpected: 'Unerwartet: „{tok}“',
  };
  let L = LABELS_DE;
  function setLabels(o) {
    L = Object.assign({}, LABELS_DE, o || {}, { names: Object.assign({}, LABELS_DE.names, (o && o.names) || {}) });
  }

  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      const start = i;
      if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
        i++;
        toks.push({ t: 'str', v: src.slice(start, Math.min(i, n)), from: start, to: Math.min(i, n) });
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
        i += m[0].length;
        toks.push({ t: 'num', v: m[0], from: start, to: i });
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
        const w = src.slice(start, i);
        toks.push({ t: 'id', v: w, from: start, to: i });
        if (w === 'include' || w === 'use') { // Pfad <…> als ein Token
          let j = i;
          while (j < n && /\s/.test(src[j])) j++;
          if (src[j] === '<') { const e = src.indexOf('>', j); const k = e < 0 ? n : e + 1; toks.push({ t: 'path', v: src.slice(j, k), from: j, to: k }); i = k; }
        }
        continue;
      }
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { toks.push({ t: 'op', v: two, from: i, to: i + 2 }); i += 2; continue; }
      toks.push({ t: 'op', v: c, from: i, to: i + 1 });
      i++;
    }
    return toks;
  }

  // ---------- Anweisungen ----------
  const BOOLEAN = new Set(['union', 'difference', 'intersection', 'hull', 'minkowski', 'render', 'group']);
  const TRANSFORM = new Set(['translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'color', 'resize', 'offset',
    'linear_extrude', 'rotate_extrude', 'projection']);
  const CONTROL = new Set(['for', 'intersection_for', 'let', 'each', 'assign']);
  const NO_OBJECT = new Set(['echo', 'assert', 'children', 'parent_module']);
  const PRIMITIVES = new Set(['cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text', 'import', 'surface']);

  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    let error = null;
    const peek = (o) => toks[p + (o || 0)];
    const isOp = (tk, v) => tk && tk.t === 'op' && tk.v === v;

    // Überspringt einen Ausdruck bis , ) ] ; auf Ebene 0
    function skipExpr(stops) {
      let depth = 0;
      while (p < toks.length) {
        const tk = toks[p];
        if (tk.t === 'op') {
          if (depth === 0 && stops.includes(tk.v)) return;
          if ('([{'.includes(tk.v)) depth++;
          else if (')]}'.includes(tk.v)) { if (depth === 0) return; depth--; }
        }
        p++;
      }
    }
    function value(a, b) { // Token a..b-1 einordnen
      const ts = toks.slice(a, b);
      if (!ts.length) return { kind: 'expr', text: '' };
      const from = ts[0].from;
      const to = ts[ts.length - 1].to;
      const text = src.slice(from, to);
      if (ts.length === 1 && ts[0].t === 'num') return { kind: 'number', value: Number(ts[0].v), from, to, text };
      if (ts.length === 2 && ts[0].t === 'op' && (ts[0].v === '-' || ts[0].v === '+') && ts[1].t === 'num' && ts[1].from === ts[0].to) {
        return { kind: 'number', value: Number(text), from, to, text };
      }
      if (ts.length === 1 && ts[0].t === 'id') {
        if (ts[0].v === 'true' || ts[0].v === 'false') return { kind: 'bool', value: ts[0].v === 'true', from, to, text };
        if (ts[0].v === 'undef') return { kind: 'expr', from, to, text };
        return { kind: 'variable', ref: ts[0].v, from, to, text };
      }
      if (ts.length === 1 && ts[0].t === 'str') return { kind: 'string', from, to, text };
      if (isOp(ts[0], '[') && isOp(ts[ts.length - 1], ']')) {
        // Vektor: Elemente auf Ebene 1 trennen
        const items = [];
        let depth = 0;
        let s = 1;
        let ok = true;
        for (let k = 1; k < ts.length; k++) {
          const tk = ts[k];
          if (tk.t === 'op' && '([{'.includes(tk.v)) depth++;
          else if (tk.t === 'op' && ')]}'.includes(tk.v)) {
            if (depth === 0 && k === ts.length - 1) { if (k > s) items.push([s, k]); break; }
            depth--;
          } else if (tk.t === 'op' && depth === 0 && tk.v === ',') { items.push([s, k]); s = k + 1; } else if (tk.t === 'op' && depth === 0 && tk.v === ':') ok = false;
        }
        if (ok) return { kind: 'vector', items: items.map(([x, y]) => value(a + x, a + y)), from, to, text };
      }
      return { kind: 'expr', from, to, text };
    }
    // ( … ) eines Aufrufs → Argumente
    function args() {
      const open = toks[p++]; // (
      const list = [];
      let pos = 0;
      while (p < toks.length && !isOp(peek(), ')')) {
        let name = null;
        let nameFrom = null;
        if (peek().t === 'id' && isOp(peek(1), '=')) { name = peek().v; nameFrom = peek().from; p += 2; }
        const a = p;
        skipExpr([',', ')']);
        const v = value(a, p);
        if (v.from === undefined) { v.from = toks[p - 1] ? toks[p - 1].to : open.to; v.to = v.from; }
        list.push(Object.assign(v, { name, pos: name ? null : pos++, argFrom: nameFrom != null ? nameFrom : v.from }));
        if (isOp(peek(), ',')) p++;
      }
      const close = toks[p];
      if (!close) throw new Error(L.errParen);
      p++;
      return { list, open: open.from, close: close.from };
    }

    function statement(parent) {
      const tk = peek();
      if (!tk) return null;
      const node = { from: tk.from, parent, children: [] };
      if (isOp(tk, ';')) { p++; node.type = 'empty'; node.to = tk.to; return node; }
      if (isOp(tk, '{')) {
        p++;
        node.type = 'block';
        while (p < toks.length && !isOp(peek(), '}')) { const s = statement(node); if (s) node.children.push(s); }
        if (!peek()) throw new Error(L.errBrace);
        node.to = toks[p++].to;
        return node;
      }
      // Modifikatoren ! # % *
      let modifier = '';
      while (peek() && peek().t === 'op' && '!#%*'.includes(peek().v)) { modifier += peek().v; p++; }
      const t2 = peek();
      if (!t2) throw new Error(L.errIncomplete);
      if (t2.t === 'id' && (t2.v === 'module' || t2.v === 'function')) {
        node.type = t2.v;
        node.name = peek(1) && peek(1).v;
        p += 2;
        if (isOp(peek(), '(')) args();
        if (t2.v === 'function') { skipExpr([';']); node.to = toks[p] ? toks[p].to : src.length; p++; return node; }
        const body = statement(node);
        node.body = body;
        node.to = body ? body.to : t2.to;
        return node;
      }
      if (t2.t === 'id' && (t2.v === 'include' || t2.v === 'use')) {
        node.type = 'include';
        p++;
        if (peek() && peek().t === 'path') p++;
        if (isOp(peek(), ';')) p++;
        node.to = toks[p - 1].to;
        return node;
      }
      if (t2.t === 'id' && isOp(peek(1), '=')) {
        node.type = 'assign';
        node.name = t2.v;
        p += 2;
        const a = p;
        skipExpr([';']);
        node.value = value(a, p);
        if (!isOp(peek(), ';')) throw new Error(L.errSemicolon.replace('{name}', t2.v));
        node.to = toks[p++].to;
        return node;
      }
      if (t2.t === 'id' && t2.v === 'if' && isOp(peek(1), '(')) {
        node.type = 'if';
        node.modifier = modifier;
        p++;
        const ar = args();
        node.headTo = toks[p - 1].to;
        node.cond = src.slice(ar.open + 1, ar.close);
        const then = statement(node);
        node.children.push(then);
        node.thenStmt = then;
        if (peek() && peek().t === 'id' && peek().v === 'else') {
          p++;
          const els = statement(node);
          node.children.push(els);
          node.elseStmt = els;
        }
        node.to = node.children[node.children.length - 1].to;
        return node;
      }
      if (t2.t === 'id' && isOp(peek(1), '(')) {
        node.type = 'call';
        node.modifier = modifier;
        node.name = t2.v;
        node.nameFrom = t2.from;
        p++;
        const ar = args();
        node.args = ar.list;
        node.open = ar.open;
        node.close = ar.close;
        if (isOp(peek(), ';')) { node.to = toks[p++].to; return node; }
        const child = statement(node);
        if (child) node.children.push(child);
        node.child = child;
        node.to = child ? child.to : node.close + 1;
        return node;
      }
      throw new Error(L.errUnexpected.replace('{tok}', t2.v));
    }

    const top = { type: 'root', children: [], from: 0, to: src.length };
    try {
      while (p < toks.length) {
        const s = statement(top);
        if (s) top.children.push(s);
      }
    } catch (e) {
      error = e.message;
    }
    return { root: top, error, src };
  }

  // ---------- Objekte sammeln ----------
  function isObjectCall(n, modules) {
    if (n.type !== 'call') return false;
    if (PRIMITIVES.has(n.name)) return true;
    if (BOOLEAN.has(n.name) || TRANSFORM.has(n.name) || CONTROL.has(n.name) || NO_OBJECT.has(n.name)) return false;
    return modules.has(n.name) || !n.child; // eigenes Modul (oder unbekannter Aufruf ohne Kinder)
  }

  // Liefert { objects, tree, assigns, error }. Objekte nur außerhalb von Modul-Definitionen.
  // tree: für die Anzeige – Knoten { kind: 'object'|'group', label/name, index, depth, subtract }
  function analyze(src) {
    const { root, error } = parse(src);
    const modules = new Set();
    const assigns = new Map(); // Name → letzte Zuweisung (oberste Ebene)
    for (const s of root.children) {
      if (s.type === 'module') modules.add(s.name);
      if (s.type === 'assign') assigns.set(s.name, s);
    }
    const objects = [];
    const tree = [];
    function walk(n, depth, subtract) {
      if (!n) return;
      if (n.type === 'module' || n.type === 'function' || n.type === 'assign' || n.type === 'include' || n.type === 'empty') return;
      if (n.type === 'block') { n.children.forEach((c) => walk(c, depth, subtract)); return; }
      if (n.type === 'call' && n.modifier && n.modifier.includes('*')) return; // deaktiviert
      if (n.type === 'call' && isObjectCall(n, modules)) {
        const obj = { index: objects.length, node: n, name: n.name, chain: chainOf(n), subtract };
        objects.push(obj);
        tree.push({ kind: 'object', index: obj.index, depth, subtract });
        return;
      }
      if (n.type === 'call' && TRANSFORM.has(n.name)) { walk(n.child, depth, subtract); return; }
      if (n.type === 'call' && BOOLEAN.has(n.name)) {
        tree.push({ kind: 'group', name: n.name, depth, subtract });
        const kids = n.child ? (n.child.type === 'block' ? n.child.children.filter((c) => c.type !== 'empty') : [n.child]) : [];
        kids.forEach((c, i) => walk(c, depth + 1, n.name === 'difference' && i > 0));
        return;
      }
      if (n.type === 'call' && CONTROL.has(n.name)) {
        tree.push({ kind: 'group', name: n.name, depth, subtract });
        walk(n.child, depth + 1, subtract);
        return;
      }
      if (n.type === 'if') {
        tree.push({ kind: 'group', name: 'if', depth, subtract });
        n.children.forEach((c) => walk(c, depth + 1, subtract));
        return;
      }
      if (n.type === 'call') walk(n.child, depth, subtract);
    }
    root.children.forEach((c) => walk(c, 0, false));
    return { objects, tree, assigns, modules, error, root };
  }

  // Transformationen direkt vor dem Objekt (nur solche, deren einziges Kind die Kette ist), von außen nach innen
  function chainOf(n) {
    const chain = [];
    let cur = n;
    let par = n.parent;
    while (par) {
      if (par.type === 'block') {
        const kids = par.children.filter((c) => c.type !== 'empty');
        if (kids.length !== 1) break;
        cur = par;
        par = par.parent;
        continue;
      }
      if (par.type === 'call' && TRANSFORM.has(par.name) && par.child === cur && !par.modifier) {
        chain.unshift(par);
        cur = par;
        par = par.parent;
        continue;
      }
      break;
    }
    return chain;
  }

  // Argument nach Name oder Position (Positionsnummer unter den unbenannten)
  function getArg(call, name, pos) {
    if (!call || !call.args) return null;
    const named = call.args.find((a) => a.name === name);
    if (named) return named;
    if (pos == null) return null;
    return call.args.find((a) => a.pos === pos) || null;
  }

  // Text zum Einfügen eines benannten Arguments ans Ende der Argumentliste
  function insertArg(call, name, text) {
    const last = call.args.filter((a) => a.text !== '' || a.name).pop();
    if (!last) return { from: call.open + 1, to: call.close, insert: name + ' = ' + text };
    return { from: last.to, to: last.to, insert: ', ' + name + ' = ' + text };
  }

  // Wie oft ein Name als Wort im Code vorkommt (ohne Zuweisungen) – für den Hinweis „wird auch woanders benutzt“
  function usageCount(src, name) {
    return tokenize(src).filter((t, i, all) => t.t === 'id' && t.v === name && !(all[i + 1] && all[i + 1].t === 'op' && all[i + 1].v === '=')).length;
  }

  // ---------- Code nur für das gewählte Objekt (Hervorhebung) ----------
  // Behält Zuweisungen, Modul-/Funktionsdefinitionen und include/use sowie die Transformationen auf dem Weg zum Objekt;
  // Geschwister (z. B. der Körper bei difference) werden weggelassen.
  function highlightCode(src, index) {
    const a = analyze(src);
    const obj = a.objects[index];
    if (!obj) return null;
    const path = [];
    for (let n = obj.node; n && n.type !== 'root'; n = n.parent) path.unshift(n);
    const out = [];
    for (const s of a.root.children) {
      if (s === path[0]) continue;
      if (['assign', 'module', 'function', 'include'].includes(s.type)) out.push(src.slice(s.from, s.to));
    }
    function emit(i) {
      const n = path[i];
      if (n === obj.node) return src.slice(n.nameFrom, n.to);
      const next = path[i + 1];
      if (n.type === 'block') return emit(i + 1);
      if (n.type === 'if') {
        const head = 'if (' + n.cond + ')';
        return next === n.thenStmt ? head + ' ' + emit(i + 1) : head + ' {} else ' + emit(i + 1);
      }
      if (n.type === 'call') {
        if (BOOLEAN.has(n.name)) return emit(i + 1);
        return src.slice(n.nameFrom, n.close + 1) + ' ' + emit(i + 1);
      }
      return emit(i + 1);
    }
    out.push(emit(0));
    return out.join('\n') + '\n';
  }

  // ---------- Objekt-Editor: Felder eines Objekts ----------
  const QUALITY = new Set(['sphere', 'cylinder', 'circle', 'fase_zylinder', 'rund_zylinder', 'rund_wuerfel']);

  // ---------- Kanten (7e.2): Quader/Zylinder ↔ Bibliotheksmodule mit Fase oder Abrundung (scriptscad.scad) ----------
  const EDGE = { cube: ['box', 'none'], fase_wuerfel: ['box', 'fase'], rund_wuerfel: ['box', 'rund'],
    cylinder: ['cyl', 'none'], fase_zylinder: ['cyl', 'fase'], rund_zylinder: ['cyl', 'rund'] };
  const EDGE_CALL = { box: { none: 'cube', fase: 'fase_wuerfel', rund: 'rund_wuerfel' }, cyl: { none: 'cylinder', fase: 'fase_zylinder', rund: 'rund_zylinder' } };
  const EDGE_DEF = { box: { fase: 1, rund: 2 }, cyl: { fase: 1, rund: 1 } }; // Standardwerte der Bibliothek
  const LIB_USE = /^[ \t]*(use|include)[ \t]*<[^>]*scriptscad\.scad[ \t]*>/m;

  // Bisherige Form als Texte (für den Umbau); null = nicht umbaubar (z. B. Kegel)
  function edgeShape(n) {
    const e = EDGE[n.name];
    if (!e) return null;
    const [fam, kind] = e;
    const t = (a) => (a ? a.text : null);
    const fn = t(getArg(n, '$fn', null));
    if (fam === 'box') {
      const size = kind === 'none' ? getArg(n, 'size', 0) : getArg(n, 'groesse', 0);
      const amount = kind === 'fase' ? getArg(n, 'fase', 1) : kind === 'rund' ? getArg(n, 'r', 1) : null;
      return { fam, kind, amount, size: t(size) || '1', center: t(getArg(n, 'center', kind === 'none' ? 1 : 2)),
        seiten: kind === 'rund' ? t(getArg(n, 'nur_seiten', 3)) : null, fn };
    }
    if (kind === 'none') {
      if (['r1', 'r2', 'd1', 'd2'].some((k) => getArg(n, k, null)) || n.args.some((a) => a.pos === 1)) return null; // Kegel (cylinder(h, r1, r2))
      const r = getArg(n, 'r', null);
      const d = getArg(n, 'd', null);
      let dt = '2';
      if (d) dt = d.text;
      else if (r) dt = r.kind === 'number' ? fmtNum(2 * r.value) : '2 * ' + (r.kind === 'variable' ? r.text : '(' + r.text + ')');
      return { fam, kind, amount: null, h: t(getArg(n, 'h', 0)) || '1', d: dt, center: t(getArg(n, 'center', 3)), fn };
    }
    return { fam, kind, amount: getArg(n, kind === 'fase' ? 'fase' : 'r', 2), d: t(getArg(n, 'd', 0)) || '2', h: t(getArg(n, 'h', 1)) || '1',
      oben: t(getArg(n, 'oben', 3)), unten: t(getArg(n, 'unten', 4)), center: t(getArg(n, 'center', 5)), fn };
  }
  // Neuer Aufruf als Text (kind = none|fase|rund, amt = Text der Fase bzw. des Radius)
  function edgeCall(sh, kind, amt) {
    const a = [];
    const amtArg = () => { if (kind !== 'none') a.push((kind === 'fase' ? 'fase = ' : 'r = ') + amt); };
    if (sh.fam === 'box') {
      a.push(sh.size);
      amtArg();
      if (sh.center) a.push('center = ' + sh.center);
      if (kind === 'rund' && sh.seiten) a.push('nur_seiten = ' + sh.seiten);
    } else {
      if (kind === 'none') a.push('h = ' + sh.h, 'd = ' + sh.d);
      else a.push('d = ' + sh.d, 'h = ' + sh.h);
      amtArg();
      if (kind !== 'none' && sh.oben) a.push('oben = ' + sh.oben);
      if (kind !== 'none' && sh.unten) a.push('unten = ' + sh.unten);
      if (sh.center) a.push('center = ' + sh.center);
    }
    if (sh.fn) a.push('$fn = ' + sh.fn);
    return EDGE_CALL[sh.fam][kind] + '(' + a.join(', ') + ')';
  }

  function decimals(t) { const i = String(t).indexOf('.'); return i < 0 || /e/i.test(String(t)) ? 0 : String(t).length - i - 1; }
  function fmtNum(x) {
    let s = (Math.round(Number(x) * 1e6) / 1e6).toFixed(6);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function stepOf(text) { const d = decimals(text); return d ? Math.max(Math.pow(10, -Math.min(d, 2)), 0.01) : 1; }

  // Wert-Knoten → bearbeitbares Ziel (Zahl direkt oder Zahl-Variable oben in der Datei)
  function resolveNum(v, ctx) {
    if (!v) return null;
    if (v.kind === 'number') return { value: v.value, from: v.from, to: v.to, text: v.text };
    if (v.kind === 'bool') return { value: v.value, from: v.from, to: v.to, text: v.text, bool: true };
    if (v.kind === 'variable') {
      const asg = ctx.assigns.get(v.ref);
      if (asg && (asg.value.kind === 'number' || asg.value.kind === 'bool')) {
        const r = resolveNum(asg.value, ctx);
        return Object.assign(r, { varName: v.ref, uses: usageCount(ctx.src, v.ref) });
      }
    }
    return null;
  }
  // Vektor (direkt oder als Variable) → Liste von Elementen
  function resolveVec(v, ctx) {
    if (!v) return null;
    if (v.kind === 'vector') return { items: v.items };
    if (v.kind === 'variable') {
      const asg = ctx.assigns.get(v.ref);
      if (asg && asg.value.kind === 'vector') return { items: asg.value.items, varName: v.ref, uses: usageCount(ctx.src, v.ref) };
    }
    return null;
  }

  // Erzeugt Felder; jedes Feld hat apply(wert) → Liste von Änderungen {from, to, insert}
  function fieldsFor(src, index) {
    const a = analyze(src);
    const obj = a.objects[index];
    if (!obj) return null;
    const ctx = { assigns: a.assigns, src };
    const n = obj.node;
    const groups = [];
    const mk = (key, label, v, opts) => {
      opts = opts || {};
      const r = resolveNum(v, ctx);
      const f = { key, label, step: opts.step || 1, min: opts.min, max: opts.max };
      if (r) {
        Object.assign(f, { value: r.value, type: r.bool ? 'bool' : 'number', editable: true, varName: r.varName || null, uses: r.uses || 0 });
        if (!r.bool && !opts.step) f.step = stepOf(r.text);
        f.apply = (val) => [{ from: r.from, to: r.to, insert: r.bool ? String(!!val) : fmtNum(val) }];
      } else if (v) {
        Object.assign(f, { type: 'number', editable: false, text: v.text });
      } else if (opts.insert) {
        Object.assign(f, { value: opts.def, type: opts.bool ? 'bool' : 'number', editable: true, missing: true, apply: opts.insert });
      } else return null;
      return f;
    };
    const vecFields = (keyBase, labels, v, opts) => {
      const rv = resolveVec(v, ctx);
      if (!rv) return null;
      const out = [];
      rv.items.forEach((it, i) => {
        if (i >= labels.length) return;
        const f = mk(keyBase + '.' + i, labels[i], it, opts);
        if (f) { if (rv.varName) { f.varName = rv.varName; f.uses = rv.uses; } out.push(f); }
      });
      return out;
    };

    // Position und Drehung aus der Kette
    const chain = obj.chain;
    const outer = chain.length ? chain[0] : n;
    const tr = chain.find((c) => c.name === 'translate');
    const ro = chain.find((c) => c.name === 'rotate');
    const XYZ = ['X', 'Y', 'Z'];
    const posFields = [];
    if (tr) {
      const v = getArg(tr, 'v', 0);
      const vf = vecFields('pos', XYZ, v, { step: 1 });
      if (vf) posFields.push(...vf);
      else if (v) posFields.push({ key: 'pos', label: 'XYZ', type: 'number', editable: false, text: v.text });
    } else {
      XYZ.forEach((l, i) => posFields.push({ key: 'pos.' + i, label: l, value: 0, type: 'number', step: 1, editable: true, missing: true,
        apply: (val) => { const p = [0, 0, 0]; p[i] = val; return [{ from: outer.from, to: outer.from, insert: 'translate([' + p.map(fmtNum).join(', ') + ']) ' }]; } }));
    }
    groups.push({ id: 'pos', fields: posFields });
    const rotFields = [];
    if (ro) {
      const v = getArg(ro, 'a', 0);
      const vf = vecFields('rot', XYZ, v, { step: 1 });
      if (vf) rotFields.push(...vf);
      else { const f = mk('rot.2', 'Z', v, { step: 1 }); if (f) rotFields.push(f); }
    } else {
      const at = n.from; // direkt vor dem Objekt
      XYZ.forEach((l, i) => rotFields.push({ key: 'rot.' + i, label: l, value: 0, type: 'number', step: 1, editable: true, missing: true,
        apply: (val) => { const p = [0, 0, 0]; p[i] = val; return [{ from: at, to: at, insert: 'rotate([' + p.map(fmtNum).join(', ') + ']) ' }]; } }));
    }
    groups.push({ id: 'rot', fields: rotFields });

    // Maße je Grundform
    const ins = (name, text) => () => [insertArg(n, name, text)];
    const insNum = (name) => (val) => [insertArg(n, name, fmtNum(val))];
    const dim = [];
    const push = (f) => { if (f) dim.push(f); };
    const sizeLike = (labels3, labelS, argName, centerPos) => {
      argName = argName || 'size';
      const v = getArg(n, argName, 0);
      const vf = vecFields('size', labels3, v, { min: 0 });
      if (vf) dim.push(...vf);
      else push(mk('size', labelS, v, { min: 0, def: 1, insert: insNum(argName) }));
      push(mk('center', L.centered, getArg(n, 'center', centerPos || 1), { bool: true, def: false, insert: (val) => [insertArg(n, 'center', String(!!val))] }));
    };
    const radius = (pos) => {
      const d = getArg(n, 'd', null);
      if (d) push(mk('d', L.diameter, d, { min: 0 }));
      else push(mk('r', L.radius, getArg(n, 'r', pos), { min: 0, def: 1, insert: insNum('r') }));
    };
    if (n.name === 'cube') sizeLike([L.width, L.depth, L.height], L.edgeLen);
    else if (n.name === 'fase_wuerfel' || n.name === 'rund_wuerfel') sizeLike([L.width, L.depth, L.height], L.edgeLen, 'groesse', 2);
    else if (n.name === 'fase_zylinder' || n.name === 'rund_zylinder') {
      push(mk('h', L.height, getArg(n, 'h', 1), { min: 0, def: 1, insert: insNum('h') }));
      const dv = getArg(n, 'd', 0);
      const twice = dv && /^2\s*\*\s*([A-Za-z_]\w*)$/.exec(dv.text); // d = 2 * radius (aus dem Umbau eines Zylinders mit r = Variable)
      const rv = twice && resolveNum({ kind: 'variable', ref: twice[1] }, ctx);
      if (rv && !rv.bool) {
        push({ key: 'd', label: L.diameter, value: 2 * rv.value, type: 'number', step: stepOf(rv.text), min: 0, editable: true,
          varName: rv.varName, uses: rv.uses, apply: (val) => [{ from: rv.from, to: rv.to, insert: fmtNum(val / 2) }] });
      } else push(mk('d', L.diameter, dv, { min: 0, def: 2, insert: insNum('d') }));
      push(mk('center', L.centered, getArg(n, 'center', 5), { bool: true, def: false, insert: (val) => [insertArg(n, 'center', String(!!val))] }));
    }
    else if (n.name === 'square') sizeLike([L.width, L.depth], L.edgeLen);
    else if (n.name === 'sphere' || n.name === 'circle') radius(0);
    else if (n.name === 'cylinder') {
      push(mk('h', L.height, getArg(n, 'h', 0), { min: 0, def: 1, insert: insNum('h') }));
      const named = ['r', 'd', 'r1', 'r2', 'd1', 'd2'].filter((k) => getArg(n, k, null));
      const p1 = getArg(n, 'r1', 1);
      const p2 = getArg(n, 'r2', 2);
      const LBL = { r: L.radius, d: L.diameter, r1: L.rBottom, r2: L.rTop, d1: L.dBottom, d2: L.dTop };
      if (named.length) named.forEach((k) => push(mk(k, LBL[k], getArg(n, k, null), { min: 0 })));
      else if (p1) { push(mk('r1', LBL.r1, p1, { min: 0 })); if (p2) push(mk('r2', LBL.r2, p2, { min: 0 })); }
      else push(mk('r', L.radius, null, { min: 0, def: 1, insert: insNum('r') }));
      push(mk('center', L.centered, getArg(n, 'center', 3), { bool: true, def: false, insert: (val) => [insertArg(n, 'center', String(!!val))] }));
    } else {
      // Allgemein: alle Zahlen-/Variablen-/Vektor-Argumente (z. B. eigene Module)
      n.args.forEach((arg, i) => {
        const label = arg.name || L.value + ' ' + (i + 1);
        if (arg.kind === 'vector' || (arg.kind === 'variable' && resolveVec(arg, ctx))) {
          const vf = vecFields('a' + i, ['1', '2', '3', '4', '5', '6'].map((k) => label + ' ' + k), arg, {});
          if (vf) dim.push(...vf);
        } else if (!/^\$/.test(arg.name || '')) push(mk('a' + i, label, arg, {}));
      });
    }
    groups.push({ id: 'dim', fields: dim });

    // Kanten: Fase / Abrundung (Umbau zu fase_wuerfel, rund_zylinder … + use <scriptscad.scad>)
    const sh = edgeShape(n);
    if (sh) {
      const ef = [];
      const conv = (kind, amt) => {
        const ch = [{ from: n.nameFrom, to: n.close + 1, insert: edgeCall(sh, kind, amt) }];
        if (kind !== 'none' && !LIB_USE.test(src)) ch.push({ from: 0, to: 0, insert: 'use <scriptscad.scad>\n' });
        return ch;
      };
      for (const k of ['fase', 'rund']) {
        const key = 'edge.' + k;
        const label = k === 'fase' ? L.chamfer : L.fillet;
        if (sh.kind === k) {
          const r = resolveNum(sh.amount, ctx);
          if (sh.amount && (!r || r.bool)) { ef.push({ key, label, type: 'number', editable: false, text: sh.amount.text }); continue; }
          const linked = !!(r && r.varName);
          ef.push({ key, label, value: r ? r.value : EDGE_DEF[sh.fam][k], type: 'number', step: 0.5, min: linked && k === 'rund' ? 0.1 : 0,
            editable: true, varName: linked ? r.varName : null, uses: linked ? r.uses : 0,
            apply: (v) => {
              if (v <= 0 && !linked) return conv('none');
              if (r) return [{ from: r.from, to: r.to, insert: fmtNum(v) }];
              return [insertArg(n, k === 'fase' ? 'fase' : 'r', fmtNum(v))];
            } });
        } else {
          ef.push({ key, label, value: 0, type: 'number', step: 0.5, min: 0, editable: true, missing: sh.kind === 'none',
            apply: (v) => (v > 0 ? conv(k, fmtNum(v)) : []) });
        }
      }
      if (sh.fam === 'box' && sh.kind === 'rund') {
        const f = mk('edge.seiten', L.vertOnly, getArg(n, 'nur_seiten', 3), { bool: true, def: false, insert: (val) => [insertArg(n, 'nur_seiten', String(!!val))] });
        if (f) ef.push(f);
      }
      if (sh.fam === 'cyl' && sh.kind !== 'none') {
        for (const [k, pos, lbl] of [['oben', 3, L.top], ['unten', 4, L.bottom]]) {
          const f = mk('edge.' + k, lbl, getArg(n, k, pos), { bool: true, def: true, insert: (val) => [insertArg(n, k, String(!!val))] });
          if (f) ef.push(f);
        }
      }
      groups.push({ id: 'edge', fields: ef, kind: sh.kind });
    }

    // Qualität ($fn)
    if (QUALITY.has(n.name)) {
      const v = getArg(n, '$fn', null);
      const glob = a.assigns.get('$fn');
      const def = glob && glob.value.kind === 'number' ? glob.value.value : 0;
      const f = mk('fn', L.quality, v, { min: 0, max: 200, step: 1, def, insert: insNum('$fn') });
      if (f && !v) f.inherited = true;
      groups.push({ id: 'quality', fields: f ? [f] : [] });
    }

    // Weitere Transformationen der Kette (z. B. linear_extrude, scale): Zahlen allgemein
    chain.filter((c) => c !== tr && c !== ro).forEach((c) => {
      const ci = chain.indexOf(c);
      const fs = [];
      c.args.forEach((arg, i) => {
        const label = arg.name || L.value + ' ' + (i + 1);
        if (arg.kind === 'vector' || (arg.kind === 'variable' && resolveVec(arg, ctx))) {
          const vf = vecFields('t' + ci + '.' + i, ['X', 'Y', 'Z', '4'].map((k) => label + ' ' + k), arg, {});
          if (vf) fs.push(...vf);
        } else if (arg.kind !== 'string' && !/^\$/.test(arg.name || '')) { const f = mk('t' + ci + '.' + i, label, arg, {}); if (f) fs.push(f); }
      });
      if (fs.length) groups.push({ id: 'chain', title: c.name, fields: fs });
    });

    // Kurzbeschreibung für die Liste
    const val = (f) => (f.editable ? fmtNum(f.value) : f.text.length > 12 ? '…' : f.text);
    let summary = '';
    const g = (k) => dim.find((f) => f.key === k);
    if (n.name === 'cube' || n.name === 'square' || n.name === 'fase_wuerfel' || n.name === 'rund_wuerfel') summary = dim.filter((f) => /^size/.test(f.key)).map(val).join(' × ');
    else if (n.name === 'sphere' || n.name === 'circle') summary = g('d') ? '⌀ ' + val(g('d')) : g('r') ? 'r ' + val(g('r')) : '';
    else if (n.name === 'fase_zylinder' || n.name === 'rund_zylinder') summary = [g('h') && 'h ' + val(g('h')), g('d') && 'd ' + val(g('d'))].filter(Boolean).join(' · ');
    else if (n.name === 'cylinder') summary = [g('h') && 'h ' + val(g('h')), ...dim.filter((f) => /^[rd]/.test(f.key)).map((f) => f.key + ' ' + val(f))].filter(Boolean).join(' · ');
    else summary = n.args.map((x) => x.text).join(', ').slice(0, 40);
    if (sh && sh.kind !== 'none') {
      const ed = groups.find((x) => x.id === 'edge').fields.find((f) => f.key === 'edge.' + sh.kind);
      if (ed) summary += (summary ? ' · ' : '') + ed.label + ' ' + val(ed);
    }
    return { index, name: n.name, title: L.names[n.name] || n.name, summary, subtract: obj.subtract, line: lineOf(src, n.nameFrom), groups };
  }
  function lineOf(src, pos) { let l = 1; for (let i = 0; i < pos; i++) if (src.charCodeAt(i) === 10) l++; return l; }

  // Öffentliche Sicht ohne Funktionen (für Anzeige/Tests)
  function inspect(src, index) {
    const r = fieldsFor(src, index);
    if (!r) return null;
    return Object.assign({}, r, { groups: r.groups.map((gr) => Object.assign({}, gr, { fields: gr.fields.map((f) => { const c = Object.assign({}, f); delete c.apply; return c; }) })) });
  }
  // Wert setzen → { ok, changes } (Änderungen in Positionen des alten Codes, gemeinsam anwenden)
  function setField(src, index, key, value) {
    const r = fieldsFor(src, index);
    if (!r) return { ok: false, error: 'stale' };
    for (const gr of r.groups) {
      const f = gr.fields.find((x) => x.key === key);
      if (!f) continue;
      if (!f.editable) return { ok: false, error: 'readonly' };
      if (f.type === 'number') {
        const num = Number(String(value).trim().replace(',', '.'));
        if (String(value).trim() === '' || !Number.isFinite(num)) return { ok: false, error: 'nan' };
        if (f.min !== undefined && num < f.min) return { ok: false, error: 'range', min: f.min, max: f.max };
        if (f.max !== undefined && num > f.max) return { ok: false, error: 'range', min: f.min, max: f.max };
        value = num;
      }
      return { ok: true, changes: f.apply(value), value };
    }
    return { ok: false, error: 'stale' };
  }
  function applyChanges(src, changes) {
    const sorted = changes.slice().sort((x, y) => y.from - x.from);
    let out = src;
    for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    return out;
  }
  // Struktur-Kennung der Objektliste (ändert sich nicht, wenn nur Zahlen geändert werden)
  function signature(src) {
    const a = analyze(src);
    return a.tree.map((t) => t.kind + t.depth + (t.kind === 'object' ? a.objects[t.index].name + a.objects[t.index].chain.map((c) => c.name).join('') : t.name) + (t.subtract ? '-' : '')).join('|') + (a.error ? '!' : '');
  }

  const api = { setLabels, tokenize, parse, analyze, getArg, insertArg, usageCount, highlightCode, inspect, setField, applyChanges, signature, fmtNum, PRIMITIVES };
  g.SCADObjects = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
