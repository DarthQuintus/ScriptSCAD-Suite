// ScriptSCAD Studio – Export in weitere Formate (Schritt 10k). Global "SCADExport", auch in Node ladbar (Tests).
// Grundlage ist die OFF-Ausgabe von OpenSCAD (enthält je Fläche die Farbe aus color(); ohne color() = Standardfarbe 249,215,44).
//  - parseOff(text)          → { verts: [[x,y,z]…], faces: [{ v: [i…], c: [r,g,b,a] | null }] }
//  - byColor(mesh)           → [{ color: [r,g,b,a] | null, faces }]   (Gruppen je Farbe)
//  - bodies(mesh)            → [[face…], …]                            (zusammenhängende Körper)
//  - stl(mesh, faces, name)  → ASCII-STL
//  - make3mf(mesh, groups)   → Uint8Array (3MF = ZIP, ein Objekt je Gruppe mit Farbe – Slicer zeigen die Farben bzw. ordnen Filamente zu)
(function (root) {
  'use strict';
  const DEFAULT_COLOR = [249, 215, 44];

  function parseOff(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter((l) => l);
    let i = 0;
    let head = lines[i++].split(/\s+/);
    if (!/^C?OFF$/i.test(head[0])) throw new Error('Keine OFF-Datei');
    let counts = head.length >= 3 ? head.slice(1).map(Number) : lines[i++].split(/\s+/).map(Number);
    const nv = counts[0], nf = counts[1];
    const verts = [];
    for (let k = 0; k < nv; k++) { const t = lines[i++].split(/\s+/).map(Number); verts.push([t[0], t[1], t[2]]); }
    const faces = [];
    for (let k = 0; k < nf; k++) {
      const t = lines[i++].split(/\s+/).map(Number);
      const n = t[0];
      const v = t.slice(1, 1 + n);
      const rest = t.slice(1 + n);
      let c = null;
      if (rest.length >= 3) {
        c = rest.slice(0, 4);
        if (c.every((x) => x <= 1) && c.some((x) => x > 0 && x < 1)) c = c.map((x) => Math.round(x * 255)); // Farben als 0…1
        if (c.length === 3) c.push(255);
        if (c[0] === DEFAULT_COLOR[0] && c[1] === DEFAULT_COLOR[1] && c[2] === DEFAULT_COLOR[2]) c = null; // keine Farbe angegeben
      }
      faces.push({ v, c });
    }
    return { verts, faces };
  }
  const colorKey = (c) => (c ? c.join(',') : '-');
  function byColor(mesh) {
    const m = new Map();
    for (const f of mesh.faces) { const k = colorKey(f.c); if (!m.has(k)) m.set(k, { color: f.c, faces: [] }); m.get(k).faces.push(f); }
    return Array.from(m.values());
  }
  // Körper = Flächen, die über gemeinsame Punkte zusammenhängen (Union-Find über die Punkt-Indizes)
  function bodies(mesh, faces) {
    faces = faces || mesh.faces;
    const parent = new Int32Array(mesh.verts.length).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const f of faces) for (let k = 1; k < f.v.length; k++) { const a = find(f.v[0]), b = find(f.v[k]); if (a !== b) parent[a] = b; }
    const groups = new Map();
    for (const f of faces) { const r = find(f.v[0]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
    // Hohlräume: eine Hülle mit negativem Volumen (Flächen zeigen nach innen) gehört zum kleinsten Körper, der sie umschließt
    const V = mesh.verts;
    const info = Array.from(groups.values()).map((fs) => {
      let vol = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const [a, b, c] of triangles(fs)) {
        const A = V[a], B = V[b], C = V[c];
        vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
      }
      for (const f of fs) for (const i of f.v) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V[i][k]); hi[k] = Math.max(hi[k], V[i][k]); }
      return { fs, vol, lo, hi };
    });
    const inside = (a, b) => a.lo.every((v, k) => v >= b.lo[k] - 1e-6) && a.hi.every((v, k) => v <= b.hi[k] + 1e-6);
    const solid = info.filter((g) => g.vol >= 0);
    for (const g of info.filter((x) => x.vol < 0)) {
      const host = solid.filter((h) => inside(g, h)).sort((x, y) => x.vol - y.vol)[0];
      if (host) host.fs = host.fs.concat(g.fs); else solid.push(g);
    }
    // nach Lage sortieren (links → rechts, vorne → hinten), damit die Nummern nachvollziehbar sind
    const center = (fs) => { let x = 0, y = 0, n = 0; for (const f of fs) for (const i of f.v) { x += V[i][0]; y += V[i][1]; n++; } return [x / n, y / n]; };
    return solid.map((g) => ({ fs: g.fs, c: center(g.fs) })).sort((a, b) => a.c[0] - b.c[0] || a.c[1] - b.c[1]).map((g) => g.fs);
  }
  const fmt = (x) => (Math.abs(x) < 1e-9 ? '0' : String(+x.toFixed(6)));
  function triangles(faces) { const out = []; for (const f of faces) for (let k = 1; k + 1 < f.v.length; k++) out.push([f.v[0], f.v[k], f.v[k + 1]]); return out; }
  function stl(mesh, faces, name) {
    const V = mesh.verts;
    const lines = ['solid ' + (name || 'ScriptSCAD')];
    for (const [a, b, c] of triangles(faces || mesh.faces)) {
      const A = V[a], B = V[b], C = V[c];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      lines.push('facet normal ' + fmt(nx) + ' ' + fmt(ny) + ' ' + fmt(nz), 'outer loop', 'vertex ' + A.map(fmt).join(' '), 'vertex ' + B.map(fmt).join(' '), 'vertex ' + C.map(fmt).join(' '), 'endloop', 'endfacet');
    }
    lines.push('endsolid ' + (name || 'ScriptSCAD'));
    return lines.join('\n') + '\n';
  }
  // 10n: Farbe je Dreieck in derselben Reihenfolge wie stl() → für die 3D-Ansicht ([r,g,b] oder null)
  function triColors(mesh, faces) { const out = []; for (const f of faces || mesh.faces) for (let k = 1; k + 1 < f.v.length; k++) out.push(f.c ? f.c.slice(0, 3) : null); return out; }
  // ---------- ZIP (ohne Kompression, „stored“) mit CRC-32 ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  const enc = (s) => new TextEncoder().encode(s);
  function zip(entries) {
    const chunks = [], central = [];
    let off = 0;
    for (const [name, data] of entries) {
      const nb = enc(name), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
      chunks.push(new Uint8Array(lh.buffer), nb, data);
      central.push(new Uint8Array(ch.buffer), nb);
      off += 30 + nb.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = chunks.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }
  const hex = (c) => '#' + c.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase() + (c[3] != null && c[3] < 255 ? Math.round(c[3]).toString(16).padStart(2, '0').toUpperCase() : '');
  // groups: [{ name, color, faces }]
  function make3mf(mesh, groups, title) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const mats = groups.map((g, i) => '<base name="' + esc(g.name || 'Farbe ' + (i + 1)) + '" displaycolor="' + hex(g.color || DEFAULT_COLOR) + '"/>').join('');
    const objs = groups.map((g, i) => {
      const used = new Map(), vs = [], ts = [];
      const idx = (v) => { let k = used.get(v); if (k === undefined) { k = vs.length; used.set(v, k); const p = mesh.verts[v]; vs.push('<vertex x="' + fmt(p[0]) + '" y="' + fmt(p[1]) + '" z="' + fmt(p[2]) + '"/>'); } return k; };
      for (const [a, b, c] of triangles(g.faces)) ts.push('<triangle v1="' + idx(a) + '" v2="' + idx(b) + '" v3="' + idx(c) + '"/>');
      return '<object id="' + (i + 2) + '" type="model" name="' + esc(g.name || 'Teil ' + (i + 1)) + '" pid="1" pindex="' + i + '"><mesh><vertices>' + vs.join('') + '</vertices><triangles>' + ts.join('') + '</triangles></mesh></object>';
    }).join('');
    const model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="de-DE" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<metadata name="Title">' + esc(title || 'ScriptSCAD') + '</metadata><metadata name="Application">ScriptSCAD Studio</metadata>' +
      '<resources><basematerials id="1">' + mats + '</basematerials>' + objs + '</resources><build>' + groups.map((g, i) => '<item objectid="' + (i + 2) + '"/>').join('') + '</build></model>\n';
    const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
    const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';
    return zip([['[Content_Types].xml', enc(types)], ['_rels/.rels', enc(rels)], ['3D/3dmodel.model', enc(model)]]);
  }
  const api = { parseOff, byColor, bodies, stl, triColors, make3mf, zip, crc32, hex, DEFAULT_COLOR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SCADExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
