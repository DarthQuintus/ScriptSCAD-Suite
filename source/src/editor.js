// Code-Editor für ScriptSCAD Studio (CodeMirror 6, MIT-Lizenz).
// Wird mit esbuild zu scriptable/ScriptSCAD/app/lib/editor.js gebündelt (tools/build.mjs).
// Stellt global window.SCADEditor bereit.
import { EditorState, StateEffect, StateField, RangeSet, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  Decoration, GutterMarker, gutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth, isolateHistory } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// ---------- OpenSCAD-Syntax (einfacher Stream-Parser) ----------
const KEYWORDS = new Set(['module', 'function', 'if', 'else', 'for', 'let', 'each', 'include', 'use', 'intersection_for', 'assert', 'echo']);
const ATOMS = new Set(['true', 'false', 'undef', 'PI']);
const BUILTINS = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text', 'import', 'surface',
  'translate', 'rotate', 'scale', 'resize', 'mirror', 'multmatrix', 'color', 'offset', 'hull', 'minkowski',
  'union', 'difference', 'intersection', 'linear_extrude', 'rotate_extrude', 'projection', 'render', 'children',
  'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'floor', 'round', 'ceil', 'ln', 'log', 'pow',
  'sqrt', 'exp', 'min', 'max', 'norm', 'cross', 'len', 'concat', 'lookup', 'str', 'chr', 'ord', 'search', 'rands',
  'is_undef', 'is_bool', 'is_num', 'is_string', 'is_list', 'is_function', 'version', 'version_num', 'parent_module',
]);

// ---------- 10h: Autovervollständigung ----------
// Eingebaute Befehle mit Parametern (OpenSCAD-Handbuch), eigene Module/Funktionen/Variablen der Datei,
// Module/Funktionen der eingebundenen Bibliotheken (window.SCAD_HINTS aus lib/scad-hints.js, erzeugt von tools/build.mjs).
const BUILTIN_SIGS = {
  cube: 'size, center = false', sphere: 'r | d', cylinder: 'h, r | d | r1, r2 | d1, d2, center = false', polyhedron: 'points, faces, convexity',
  square: 'size, center = false', circle: 'r | d', polygon: 'points, paths, convexity', text: 'text, size = 10, font, halign, valign, spacing',
  import: 'file, convexity', surface: 'file, center, invert, convexity', translate: 'v', rotate: 'a, v', scale: 'v', resize: 'newsize, auto',
  mirror: 'v', multmatrix: 'm', color: 'c, alpha', offset: 'r | delta, chamfer', hull: '', minkowski: '', union: '', difference: '', intersection: '',
  linear_extrude: 'height, center, convexity, twist, slices, scale', rotate_extrude: 'angle = 360, convexity', projection: 'cut = false', render: 'convexity',
  children: 'index', echo: '…', assert: 'condition, message',
  abs: 'x', sign: 'x', sin: 'deg', cos: 'deg', tan: 'deg', asin: 'x', acos: 'x', atan: 'x', atan2: 'y, x', floor: 'x', round: 'x', ceil: 'x', ln: 'x', log: 'x',
  pow: 'base, exp', sqrt: 'x', exp: 'x', min: 'a, b, …', max: 'a, b, …', norm: 'v', cross: 'a, b', len: 'v', concat: 'a, b, …', lookup: 'key, table',
  str: '…', chr: 'n', ord: 'c', search: 'match, list', rands: 'min, max, n, seed', is_undef: 'x', is_bool: 'x', is_num: 'x', is_string: 'x', is_list: 'x', is_function: 'x',
};
const KEYWORD_LIST = ['module', 'function', 'if', 'else', 'for', 'let', 'each', 'include', 'use', 'intersection_for', 'true', 'false', 'undef',
  '$fn', '$fa', '$fs', '$t', '$preview'];
function callApply(name) {
  return (view, completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: name + '()' }, selection: { anchor: from + name.length + 1 }, userEvent: 'input.complete' });
  };
}
function libraryRoots(doc) {
  const roots = new Set();
  const re = /\b(?:include|use)\s*<([^>]+)>/g;
  let m;
  while ((m = re.exec(doc))) { const f = m[1].trim(); roots.add(f.includes('/') ? f.split('/')[0] + '/' : f); }
  return roots;
}
function scadCompletions(context) {
  const word = context.matchBefore(/\$?[A-Za-z_][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  if (/\/\//.test(before) || (before.split('"').length - 1) % 2 === 1) return null; // in Kommentar oder Text
  const doc = context.state.doc.toString();
  const seen = new Set();
  const options = [];
  const add = (o) => { if (seen.has(o.label)) return; seen.add(o.label); options.push(o); };
  // eigene Module/Funktionen und Variablen der Datei
  const defRe = /\b(module|function)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = defRe.exec(doc))) add({ label: m[2], type: m[1] === 'module' ? 'class' : 'function', detail: '(' + m[3].replace(/\s+/g, ' ').trim() + ')', info: 'in dieser Datei', boost: 3, apply: callApply(m[2]) });
  const varRe = /^\s*([A-Za-z_]\w*)\s*=/gm;
  while ((m = varRe.exec(doc))) add({ label: m[1], type: 'variable', boost: 2 });
  for (const [n, p] of Object.entries(BUILTIN_SIGS)) add({ label: n, type: 'function', detail: '(' + p + ')', boost: 1, apply: callApply(n) });
  for (const k of KEYWORD_LIST) add({ label: k, type: 'keyword' });
  // Bibliotheken: nur die, die per include/use eingebunden sind
  const roots = libraryRoots(doc);
  const hints = (typeof window !== 'undefined' && window.SCAD_HINTS) || [];
  if (roots.size) for (const h of hints) {
    const r = h.f.includes('/') ? h.f.split('/')[0] + '/' : h.f;
    if (!roots.has(r)) continue;
    add({ label: h.n, type: h.k === 'm' ? 'class' : 'function', detail: '(' + h.p + ')', info: h.f, apply: callApply(h.n) });
  }
  return { from: word ? word.from : context.pos, options, validFor: /^\$?[A-Za-z0-9_]*$/ };
}

const openscadMode = {
  name: 'openscad',
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo('*/')) { stream.match('*/'); state.inComment = false; } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.inComment = true; return 'comment'; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^\$[A-Za-z_]\w*/)) return 'atom';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return 'keyword';
      if (ATOMS.has(w)) return 'atom';
      if (BUILTINS.has(w)) return 'builtin';
      return 'variableName';
    }
    if (stream.match(/^[+\-*/%^<>=!&|?:]+/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', '"'] } },
};

// Farben kommen aus CSS-Variablen (style.css, je Modus dunkel/hell) – Rückfallwerte = helles Thema
const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--syn-comment, #6a7f6a)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--syn-keyword, #a626a4)', fontWeight: '600' },
  { tag: t.standard(t.variableName), color: 'var(--syn-builtin, #2f6fde)' },
  { tag: t.number, color: 'var(--syn-number, #c2410c)' },
  { tag: t.string, color: 'var(--syn-string, #2e7d32)' },
  { tag: t.atom, color: 'var(--syn-atom, #b45309)' },
  { tag: t.operator, color: 'var(--syn-operator, #555)' },
]);

// ---------- Fehler-Markierungen (Zeilen mit ERROR/WARNING) ----------
const setMarks = StateEffect.define();
class DotMarker extends GutterMarker {
  constructor(kind) { super(); this.kind = kind; }
  eq(o) { return o.kind === this.kind; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-mark-' + this.kind; s.textContent = '●'; return s; }
}
const marksField = StateField.define({
  create: () => ({ lines: Decoration.none, dots: RangeSet.empty }),
  update(value, tr) {
    let v = { lines: value.lines.map(tr.changes), dots: value.dots.map(tr.changes) };
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const doc = tr.state.doc;
      const marks = e.value.filter((m) => m.line >= 1 && m.line <= doc.lines).sort((a, b) => a.line - b.line);
      const seen = new Set();
      const lineDecos = [];
      const dotDecos = [];
      for (const m of marks) {
        if (seen.has(m.line)) continue;
        seen.add(m.line);
        const from = doc.line(m.line).from;
        lineDecos.push(Decoration.line({ class: 'cm-line-' + m.kind }).range(from));
        dotDecos.push(new DotMarker(m.kind).range(from));
      }
      v = { lines: Decoration.set(lineDecos), dots: RangeSet.of(dotDecos) };
    }
    return v;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.lines)],
});
const marksGutter = gutter({ class: 'cm-marks', markers: (view) => view.state.field(marksField).dots });

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'inherit', backgroundColor: 'var(--cm-bg, #fff)', color: 'var(--cm-fg, #1d2330)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--cm-caret, #1d2330)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret, #1d2330)' },
  '.cm-gutters': { backgroundColor: 'var(--cm-gutter-bg, #f3f5f8)', color: 'var(--cm-gutter-fg, #8a93a3)', border: 'none', borderRight: '1px solid var(--cm-gutter-line, transparent)' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active, #f2f6ff)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-gutter, #e6eefc)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': { backgroundColor: 'var(--cm-selection, #cfe0fb) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-bracket, #dbe8ff)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'var(--cm-search, #ffe58a)' },
  '.cm-panels': { backgroundColor: 'var(--cm-panel-bg, #f3f5f8)', color: 'var(--cm-fg, #1d2330)' },
  '.cm-line-error': { backgroundColor: 'var(--cm-line-error, #fde8e6)' },
  '.cm-line-warning': { backgroundColor: 'var(--cm-line-warning, #fff6dc)' },
  '.cm-marks': { width: '14px' },
  '.cm-mark-error': { color: 'var(--err, #c0392b)' },
  '.cm-mark-warning': { color: 'var(--warn, #d89614)' },
  '&.cm-focused': { outline: 'none' },
});

function createEditor(parent, { onChange, onRun, onSave } = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions: extensions() }),
  });
  function extensions() {
    return [
      lineNumbers(), marksGutter, highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
      history(), bracketMatching(), closeBrackets(), indentOnInput(), indentUnit.of('  '), highlightSelectionMatches(),
      StreamLanguage.define(openscadMode), syntaxHighlighting(highlight), marksField, theme,
      autocompletion({ override: [scadCompletions], activateOnTyping: true, maxRenderedOptions: 60, icons: false }), // 10h
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      // Eigene Kürzel mit Vorrang (⌘↩ wäre sonst „Leerzeile einfügen“)
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { if (onRun) onRun(); return true; } },
        { key: 'Mod-s', run: () => { if (onSave) onSave(); return true; }, preventDefault: true },
      ])),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(); }),
    ];
  }
  return {
    // Neues Dokument laden (setzt Rückgängig-Verlauf zurück)
    setCode(code) { view.setState(EditorState.create({ doc: code, extensions: extensions() })); },
    // Ganzen Inhalt ersetzen, aber rückgängig machbar (z. B. Version wiederherstellen)
    replaceAll(code) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } }); },
    // Teil des Codes ersetzen (Parameter-Regler). newGroup = true: eigener Rückgängig-Schritt;
    // sonst werden schnelle Änderungen (Ziehen am Regler) zu einem Schritt zusammengefasst.
    replaceRange(from, to, insert, newGroup) {
      view.dispatch({
        changes: { from, to, insert },
        userEvent: 'input.type.param',
        annotations: newGroup ? isolateHistory.of('before') : [],
      });
    },
    // Mehrere Änderungen auf einmal (Positionen im alten Text), z. B. Objekt-Editor
    applyChanges(changes, newGroup) {
      view.dispatch({
        changes,
        userEvent: 'input.type.param',
        annotations: newGroup ? isolateHistory.of('before') : [],
      });
    },
    remeasure: () => view.requestMeasure(),
    getCode: () => view.state.doc.toString(),
    setMarks(marks) { view.dispatch({ effects: setMarks.of(marks) }); },
    gotoLine(n) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(doc.lines, n)));
      view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      view.focus();
    },
    undo: () => undo(view),
    redo: () => redo(view),
    canUndo: () => undoDepth(view.state) > 0,
    canRedo: () => redoDepth(view.state) > 0,
    blur: () => view.contentDOM.blur(),
    focus: () => view.focus(),
    view,
  };
}

window.SCADEditor = { createEditor, _completions: scadCompletions }; // _completions nur für Tests
