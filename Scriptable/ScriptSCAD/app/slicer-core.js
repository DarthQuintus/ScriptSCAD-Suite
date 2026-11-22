// ScriptSCAD Slicer – Kern ohne Oberfläche (läuft in der WebView und in Node-Tests).
// Global "SlicerCore". Aufgaben:
//  - STL lesen (ASCII oder binär), auf das Druckbett legen (Mitte, Unterseite auf Z = 0), als binäre STL ausgeben
//  - Druckerprofil → Cura-Druckerdefinition + Befehlszeile für CuraEngine
//  - Platzhalter im Start-/End-G-Code ersetzen (Cura {name}, PrusaSlicer/Orca [name]) – CuraEngine selbst ersetzt sie NICHT
//  - G-Code nachbearbeiten (Kopf mit Druckzeit/Filament) und in Ebenen zerlegen (Vorschau)
(function (root) {
  'use strict';

  // ---------- STL ----------
  function isBinaryStl(bytes) {
    if (bytes.length < 84) return false;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) return true;
    // ASCII beginnt mit „solid“ und enthält „facet“
    const head = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(512, bytes.length)));
    return !(/^\s*solid/.test(head) && /facet/.test(head));
  }

  // → Float32Array mit 9 Werten je Dreieck
  function parseStl(bytes) {
    if (isBinaryStl(bytes)) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = dv.getUint32(80, true);
      const tri = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) tri[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return tri;
    }
    const text = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('utf8');
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const vals = [];
    let m;
    while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
    if (!vals.length || vals.length % 9) throw new Error('STL ungültig (' + vals.length / 3 + ' Eckpunkte)');
    return new Float32Array(vals);
  }

  function bounds(tri) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tri.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = tri[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    }
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }

  // Modell in die Bettmitte legen, Unterseite auf Z = 0 → binäre STL (Uint8Array).
  // CuraEngine (machine_center_is_zero = false) verschiebt das Modell selbst um die halbe Bettgröße
  // → Modellmitte hier auf X/Y = 0 legen (Container-Test 9a: sonst lag ein Würfel am Bettrand bei X 210–230).
  function placeOnBed(tri, bedW, bedD) {
    const b = bounds(tri);
    const dx = -(b.min[0] + b.max[0]) / 2, dy = -(b.min[1] + b.max[1]) / 2, dz = -b.min[2];
    const n = tri.length / 9;
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, n, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50;
      for (let v = 0; v < 3; v++) {
        dv.setFloat32(o + 12 + v * 12, tri[i * 9 + v * 3] + dx, true);
        dv.setFloat32(o + 16 + v * 12, tri[i * 9 + v * 3 + 1] + dy, true);
        dv.setFloat32(o + 20 + v * 12, tri[i * 9 + v * 3 + 2] + dz, true);
      }
    }
    return { stl: new Uint8Array(buf), size: b.size, triangles: n, offset: [dx, dy, dz], fits: b.size[0] <= bedW && b.size[1] <= bedD };
  }

  // ---------- Druckplatte mit mehreren Objekten (9e) ----------
  // Objekt-Dreiecke so verschieben, dass die Grundfläche mittig um X/Y = 0 liegt und die Unterseite auf Z = 0
  function centerTri(tri) {
    const b = bounds(tri);
    const dx = -(b.min[0] + b.max[0]) / 2, dy = -(b.min[1] + b.max[1]) / 2, dz = -b.min[2];
    const out = new Float32Array(tri.length);
    for (let i = 0; i < tri.length; i += 3) { out[i] = tri[i] + dx; out[i + 1] = tri[i + 1] + dy; out[i + 2] = tri[i + 2] + dz; }
    return { tri: out, size: b.size };
  }
  // Automatisch anordnen: Reihen („Regalbretter“), größte Grundfläche zuerst, Abstand gap; ganzer Block mittig auf dem Bett.
  // objs: [{ size: [x, y, z] }] → [{ x, y }] (Mitte des Objekts relativ zur Bettmitte), gleiche Reihenfolge
  function arrange(objs, bedW, bedD, gap) {
    gap = gap == null ? 5 : gap;
    const order = objs.map((o, i) => i).sort((a, b) => objs[b].size[0] * objs[b].size[1] - objs[a].size[0] * objs[a].size[1] || a - b);
    const rows = [];
    let row = null;
    for (const i of order) {
      const [w, d] = objs[i].size;
      if (!row || (row.w > 0 && row.w + gap + w > bedW)) { row = { items: [], w: 0, d: 0 }; rows.push(row); }
      row.items.push({ i, x: row.w + (row.w > 0 ? gap : 0), w, d });
      row.w += (row.w > 0 ? gap : 0) + w;
      row.d = Math.max(row.d, d);
    }
    const totalD = rows.reduce((s, r) => s + r.d, 0) + gap * Math.max(0, rows.length - 1);
    const pos = new Array(objs.length);
    let y = totalD / 2; // erste Reihe hinten (oben in der Ansicht von oben)
    for (const r of rows) {
      const x0 = -r.w / 2;
      for (const it of r.items) pos[it.i] = { x: +(x0 + it.x + it.w / 2).toFixed(3), y: +(y - r.d / 2).toFixed(3) };
      y -= r.d + gap;
    }
    return pos;
  }
  // Prüfen: außerhalb des Betts (Rechteck bzw. Ellipse beim runden Bett), zu hoch, Überlappung der Grundflächen
  // objs: [{ size, x, y }] → [{ outside, tooHigh, overlap }]
  function checkLayout(objs, bed) {
    const res = objs.map(() => ({ outside: false, tooHigh: false, overlap: false }));
    const eps = 0.01;
    objs.forEach((o, i) => {
      const x0 = o.x - o.size[0] / 2, x1 = o.x + o.size[0] / 2, y0 = o.y - o.size[1] / 2, y1 = o.y + o.size[1] / 2;
      if (bed.round) {
        const rx = bed.w / 2, ry = bed.d / 2;
        res[i].outside = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].some(([x, y]) => (x / rx) ** 2 + (y / ry) ** 2 > 1 + eps);
      } else res[i].outside = x0 < -bed.w / 2 - eps || x1 > bed.w / 2 + eps || y0 < -bed.d / 2 - eps || y1 > bed.d / 2 + eps;
      res[i].tooHigh = o.size[2] > bed.h + eps;
      for (let j = 0; j < i; j++) {
        const p = objs[j];
        if (Math.abs(o.x - p.x) < (o.size[0] + p.size[0]) / 2 - eps && Math.abs(o.y - p.y) < (o.size[1] + p.size[1]) / 2 - eps) { res[i].overlap = true; res[j].overlap = true; }
      }
    });
    return res;
  }
  // Alle Objekte (zentrierte Dreiecke + Lage x/y) zu einer binären STL – Koordinaten relativ zur Bettmitte (CuraEngine verschiebt selbst um die halbe Bettgröße)
  function mergeObjects(objs) {
    const n = objs.reduce((s, o) => s + o.tri.length / 9, 0);
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, n, true);
    let t = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const o of objs) {
      const tri = o.tri;
      for (let i = 0; i < tri.length / 9; i++, t++) {
        const off = 84 + t * 50;
        for (let v = 0; v < 3; v++) {
          const x = tri[i * 9 + v * 3] + o.x, y = tri[i * 9 + v * 3 + 1] + o.y, z = tri[i * 9 + v * 3 + 2];
          dv.setFloat32(off + 12 + v * 12, x, true); dv.setFloat32(off + 16 + v * 12, y, true); dv.setFloat32(off + 20 + v * 12, z, true);
          if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
          if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
        }
      }
    }
    return { stl: new Uint8Array(buf), triangles: n, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }

  // ---------- Objekte drehen, skalieren, aufteilen (9f) ----------
  // Drehung wie OpenSCAD rotate([x, y, z]) (erst X, dann Y, dann Z), danach Skalierung in den Achsen des Druckers:
  // v' = S · Rz · Ry · Rx · v  → die Maße in mm je Achse stimmen auch bei gedrehten Objekten genau.
  const RAD = Math.PI / 180;
  function eulerToMat(rot) {
    const cx = Math.cos(rot[0] * RAD), sx = Math.sin(rot[0] * RAD), cy = Math.cos(rot[1] * RAD), sy = Math.sin(rot[1] * RAD), cz = Math.cos(rot[2] * RAD), sz = Math.sin(rot[2] * RAD);
    return [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
      cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
      -sy, sx * cy, cx * cy];
  }
  function matToEuler(m) {
    const norm = (d) => { let v = +d.toFixed(3); if (v <= -180) v += 360; if (v > 180) v -= 360; return Object.is(v, -0) ? 0 : v; };
    const sy = Math.max(-1, Math.min(1, -m[6]));
    const ry = Math.asin(sy);
    let rx, rz;
    if (Math.abs(Math.cos(ry)) > 1e-6) { rx = Math.atan2(m[7], m[8]); rz = Math.atan2(m[3], m[0]); } else { rz = 0; rx = Math.atan2(-m[5], m[4]); }
    return [norm(rx / RAD), norm(ry / RAD), norm(rz / RAD)];
  }
  function matMul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  // Drehmatrix, die den Einheitsvektor a auf b dreht
  function alignMat(a, b) {
    const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (c > 1 - 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (c < -1 + 1e-9) {
      // genau entgegengesetzt: halbe Drehung um eine Achse senkrecht zu a
      const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let u = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
      const l = Math.hypot(u[0], u[1], u[2]); u = u.map((x) => x / l);
      return [2 * u[0] * u[0] - 1, 2 * u[0] * u[1], 2 * u[0] * u[2], 2 * u[0] * u[1], 2 * u[1] * u[1] - 1, 2 * u[1] * u[2], 2 * u[0] * u[2], 2 * u[1] * u[2], 2 * u[2] * u[2] - 1];
    }
    const k = 1 / (1 + c);
    return [1 - k * (v[1] * v[1] + v[2] * v[2]), k * v[0] * v[1] - v[2], k * v[0] * v[2] + v[1],
      k * v[0] * v[1] + v[2], 1 - k * (v[0] * v[0] + v[2] * v[2]), k * v[1] * v[2] - v[0],
      k * v[0] * v[2] - v[1], k * v[1] * v[2] + v[0], 1 - k * (v[0] * v[0] + v[1] * v[1])];
  }
  function applyMat(tri, m, scale) {
    const out = new Float32Array(tri.length);
    const s = scale || [1, 1, 1];
    for (let i = 0; i < tri.length; i += 3) {
      const x = tri[i], y = tri[i + 1], z = tri[i + 2];
      out[i] = s[0] * (m[0] * x + m[1] * y + m[2] * z);
      out[i + 1] = s[1] * (m[3] * x + m[4] * y + m[5] * z);
      out[i + 2] = s[2] * (m[6] * x + m[7] * y + m[8] * z);
    }
    // Spiegelung (ungerade Zahl negativer Faktoren) dreht die Dreiecke um → Reihenfolge tauschen, damit außen außen bleibt
    if (s[0] * s[1] * s[2] < 0) for (let i = 0; i < out.length; i += 9) for (let k = 0; k < 3; k++) { const t = out[i + 3 + k]; out[i + 3 + k] = out[i + 6 + k]; out[i + 6 + k] = t; }
    return out;
  }
  // Grundform (base) → gedreht, skaliert, mittig auf das Bett gelegt: { tri, size }
  function transformTri(base, scale, rot) {
    const plain = (!rot || (!rot[0] && !rot[1] && !rot[2])) && (!scale || (scale[0] === 1 && scale[1] === 1 && scale[2] === 1));
    return centerTri(plain ? base : applyMat(base, eulerToMat(rot || [0, 0, 0]), scale));
  }
  // Zusammenhängende Teile (gemeinsame Eckpunkte) → Liste von Dreiecks-Feldern, in der Reihenfolge ihres ersten Dreiecks
  function components(tri) {
    const n = tri.length / 9;
    const ids = new Map();
    const vert = new Int32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      const k = Math.round(tri[i * 3] * 1000) + ',' + Math.round(tri[i * 3 + 1] * 1000) + ',' + Math.round(tri[i * 3 + 2] * 1000);
      let id = ids.get(k);
      if (id === undefined) { id = ids.size; ids.set(k, id); }
      vert[i] = id;
    }
    const parent = new Int32Array(ids.size);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let t = 0; t < n; t++) {
      const a = find(vert[t * 3]), b = find(vert[t * 3 + 1]), c = find(vert[t * 3 + 2]);
      if (b !== a) parent[b] = a;
      const c2 = find(c);
      if (c2 !== a) parent[c2] = a;
    }
    const groups = new Map();
    for (let t = 0; t < n; t++) {
      const r = find(vert[t * 3]);
      let g = groups.get(r);
      if (!g) { g = []; groups.set(r, g); }
      g.push(t);
    }
    return Array.from(groups.values()).map((g) => {
      const out = new Float32Array(g.length * 9);
      g.forEach((t, i) => out.set(tri.subarray(t * 9, t * 9 + 9), i * 9));
      return out;
    });
  }
  // Mitte der Grundfläche (X/Y) und Unterkante (Z) eines Teils – für die Lage nach dem Aufteilen
  function footCenter(tri) { const b = bounds(tri); return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]]; }
  // Ebene Außenflächen, auf die sich ein Objekt legen lässt: größte zuerst → [{ n: [x, y, z], area }]
  function flatFaces(tri, max) {
    const n = tri.length / 9;
    const cl = new Map();
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
      const vx = tri[o + 6] - tri[o], vy = tri[o + 7] - tri[o + 1], vz = tri[o + 8] - tri[o + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const key = Math.round(nx * 50) + ',' + Math.round(ny * 50) + ',' + Math.round(nz * 50);
      let c = cl.get(key);
      if (!c) { c = { n: [0, 0, 0], area: 0, tris: [] }; cl.set(key, c); }
      c.n[0] += nx * l; c.n[1] += ny * l; c.n[2] += nz * l; c.area += l / 2; c.tris.push(t);
    }
    const cand = Array.from(cl.values()).sort((a, b) => b.area - a.area).slice(0, 24);
    const res = [];
    for (const c of cand) {
      const l = Math.hypot(c.n[0], c.n[1], c.n[2]);
      const nn = [c.n[0] / l, c.n[1] / l, c.n[2] / l];
      // äußerste Ebene in dieser Richtung; nur Dreiecke darauf zählen (innenliegende Flächen taugen nicht als Auflage)
      let sup = -Infinity;
      for (let i = 0; i < tri.length; i += 3) { const d = tri[i] * nn[0] + tri[i + 1] * nn[1] + tri[i + 2] * nn[2]; if (d > sup) sup = d; }
      let area = 0;
      for (const t of c.tris) {
        const o = t * 9;
        const d = tri[o] * nn[0] + tri[o + 1] * nn[1] + tri[o + 2] * nn[2];
        if (sup - d > 0.05) continue;
        const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
        const vx = tri[o + 6] - tri[o], vy = tri[o + 7] - tri[o + 1], vz = tri[o + 8] - tri[o + 2];
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
      if (area > 0.5) res.push({ n: nn, area });
    }
    res.sort((a, b) => b.area - a.area);
    return res.slice(0, max || 8);
  }

  // Eingebautes Testmodell: Würfel (binäre STL)
  function cubeTri(a) {
    const v = [[0, 0, 0], [a, 0, 0], [a, a, 0], [0, a, 0], [0, 0, a], [a, 0, a], [a, a, a], [0, a, a]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const tri = new Float32Array(f.length * 9);
    f.forEach((t, i) => t.forEach((vi, k) => { tri[i * 9 + k * 3] = v[vi][0]; tri[i * 9 + k * 3 + 1] = v[vi][1]; tri[i * 9 + k * 3 + 2] = v[vi][2]; }));
    return tri;
  }
  function cubeStl(a) {
    const v = [[0, 0, 0], [a, 0, 0], [a, a, 0], [0, a, 0], [0, 0, a], [a, 0, a], [a, a, a], [0, a, a]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const tri = new Float32Array(f.length * 9);
    f.forEach((t, i) => t.forEach((vi, k) => { tri[i * 9 + k * 3] = v[vi][0]; tri[i * 9 + k * 3 + 1] = v[vi][1]; tri[i * 9 + k * 3 + 2] = v[vi][2]; }));
    return placeOnBed(tri, 0, 0).stl;
  }

  // ---------- Platzhalter + Makros ----------
  // Start-/End-/Schicht-G-Code der Drucker stammt aus Cura ({name}), PrusaSlicer ([name]) und OrcaSlicer/Bambu Studio (Makrosprache:
  // {if …}{elsif …}{else}{endif}, Formeln wie {nozzle_temperature_initial_layer[initial_extruder]-50}, {first_layer_print_min[0]}).
  // CuraEngine ersetzt nichts davon → hier ausgewertet (10p). Unbekannte Namen bleiben stehen und werden gemeldet.
  // Werkstoff-Kennwerte, die Orca-Start-Codes brauchen (max. Volumenstrom mm³/s, Glasübergang °C, Dichte g/cm³)
  const MATERIAL_INFO = {
    PLA: { maxVol: 18, vitrification: 55, density: 1.24, low: 190, high: 240, id: 'GFL99' },
    PETG: { maxVol: 12, vitrification: 70, density: 1.27, low: 220, high: 270, id: 'GFG99' },
    ABS: { maxVol: 16, vitrification: 100, density: 1.04, low: 240, high: 280, id: 'GFB99' },
    TPU: { maxVol: 3.6, vitrification: 30, density: 1.22, low: 200, high: 250, id: 'GFU99' },
  };
  // Werte für alle bekannten Namen. p = Profil (Drucker + Regler + Material), p.bounds = { min, max } der Druckplatte (falls bekannt),
  // extra = Werte, die erst beim Schichtwechsel feststehen (layer_num, layer_z, total_layer_count)
  function placeholderValues(p, extra) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const py = (b) => (b ? 'True' : 'False'); // Cura schreibt Wahrheitswerte wie Python
    const mat = String(p.material || 'PLA');
    const mi = MATERIAL_INFO[mat] || MATERIAL_INFO.PLA;
    const bx = p.bedX, by = p.bedY;
    const c0 = p.centerZero ? [-bx / 2, -by / 2] : [0, 0]; // Bett-Ecke vorne links
    const b = p.bounds || { min: [c0[0] + bx / 2 - 10, c0[1] + by / 2 - 10, 0], max: [c0[0] + bx / 2 + 10, c0[1] + by / 2 + 10, 10] };
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const fMin = [r3(b.min[0]), r3(b.min[1])], fMax = [r3(b.max[0]), r3(b.max[1])];
    const lh = p.layerHeight || 0.2, lh0 = p.layerHeight0 || lh;
    const maxZ = r3(Math.max(lh0, lh0 + Math.ceil(Math.max(0, (b.max[2] || 0) - lh0) / lh - 1e-6) * lh));
    const lw = p.lineWidth || 0.42;
    const outerVol = Math.min(mi.maxVol, (p.speedOuterWall || 60) * lw * lh);
    const accel = p.maxAccel || 5000;
    const v = {
      // Cura {name}
      material_print_temperature: p.nozzleTemp, material_print_temperature_layer_0: p.nozzleTemp0, default_material_print_temperature: p.nozzleTemp,
      material_bed_temperature: p.bedTemp, material_bed_temperature_layer_0: p.bedTemp0, material_standby_temperature: p.nozzleTemp,
      build_volume_temperature: 0, initial_extruder_nr: 0,
      speed_travel: p.travelSpeed, layer_height: lh, layer_height_0: lh0, line_width: lw, infill_line_width: lw,
      wall_thickness: +(p.walls * lw).toFixed(3), top_bottom_thickness: +(p.topLayers * lh).toFixed(3),
      top_thickness: +(p.topLayers * lh).toFixed(3), bottom_thickness: +(p.bottomLayers * lh).toFixed(3),
      infill_sparse_density: p.infill, infill_pattern: p.infillPattern, wall_0_wipe_dist: 0,
      cool_fan_speed_min: p.fanMin, cool_fan_speed_max: p.fanMax, retraction_amount: p.retract, retraction_retract_speed: p.retractSpeed,
      retraction_prime_speed: p.retractSpeed, switch_extruder_retraction_amount: 16, adhesion_type: p.adhesion, support_enable: py(!!p.support),
      magic_spiralize: py(!!p.vase), machine_nozzle_size: p.nozzle, material_diameter: p.filamentDiameter, machine_name: p.name,
      machine_width: bx, machine_depth: by, machine_height: p.bedZ, material_type: mat,
      day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()], date: pad(now.getDate()) + '-' + pad(now.getMonth() + 1) + '-' + now.getFullYear(),
      time: pad(now.getHours()) + ':' + pad(now.getMinutes()), jobname: 'ScriptSCAD', print_time: '', filament_amount: '', filament_weight: '', filament_cost: '',
      material_profile: '', profile_string: '',
      // ältere Cura-Namen / PrusaSlicer / Orca [name]
      print_temperature: p.nozzleTemp, print_bed_temperature: p.bedTemp, fill_density: p.infill, fill_distance: '', print_speed: p.speedPrint,
      retraction_speed: p.retractSpeed, support: p.support ? 1 : 0,
      first_layer_temperature: p.nozzleTemp0, temperature: p.nozzleTemp, nozzle_temperature: p.nozzleTemp,
      nozzle_temperature_initial_layer: p.nozzleTemp0, first_layer_bed_temperature: p.bedTemp0, bed_temperature: p.bedTemp,
      bed_temperature_initial_layer: p.bedTemp0, bed_temperature_initial_layer_single: p.bedTemp0, hot_plate_temp: p.bedTemp, hot_plate_temp_initial_layer: p.bedTemp0,
      initial_layer_print_height: lh0, travel_speed: p.travelSpeed, first_layer_height: lh0,
      printer_model: p.name, printer_preset: p.name, print_preset: 'ScriptSCAD', filament_preset: '', layer_height_mm: lh, // 10f: PrusaSlicer-Namen
      // 10p: OrcaSlicer / Bambu Studio
      initial_extruder: 0, initial_tool: 0, initial_no_support_extruder: 0, current_extruder: 0, current_hotend: 0, initial_no_support_hotend: 0,
      first_non_support_hotend: 0, initial_nozzle_id: 0, current_nozzle_id: 0, num_extruders: 1, total_toolchanges: 0, used_tools: [0],
      first_filaments: [0], first_non_support_filaments: [0], filament_map: [1], parallel_printheads_count: 1,
      is_extruder_used: [true, false, false, false, false, false, false, false], has_wipe_tower: false, enable_prime_tower: false, wipe_tower_center_pos_valid: false,
      filament_type: mat, filament_settings_id: 'Generic ' + mat, print_settings_id: 'ScriptSCAD', printer_settings_id: p.name,
      filament_ids: mi.id, initial_filament_id: mi.id, current_filament_id: mi.id, initial_no_support_filament_id: 0,
      filament_notes: '', printer_notes: '', plate_name: 'ScriptSCAD', input_filename_base: 'ScriptSCAD',
      filament_diameter: p.filamentDiameter || 1.75, filament_area: +(Math.PI * Math.pow((p.filamentDiameter || 1.75) / 2, 2)).toFixed(4),
      nozzle_diameter: p.nozzle, nozzle_diameter_at_nozzle_id: p.nozzle, required_nozzle_HRC: 0,
      retraction_length: p.retract, retract_length: p.retract, retract_length_toolchange: 2, deretract_length: 0, retract_restart_extra_toolchange: 0,
      retraction_distances_when_cut: 18, retraction_distance_when_cut: 18, long_retraction_when_cut: false, long_retraction_when_ec: false, retraction_distance_when_ec: 0,
      e_retracted: 0, z_hop: p.zHop || 0, z_offset: 0,
      filament_max_volumetric_speed: mi.maxVol, outer_wall_volumetric_speed: +outerVol.toFixed(3),
      flush_volumetric_speeds: mi.maxVol, filament_flush_volumetric_speed: mi.maxVol, flush_temperatures: p.nozzleTemp,
      temperature_vitrification: mi.vitrification, min_vitrification_temperature: mi.vitrification,
      nozzle_temperature_range_low: mi.low, nozzle_temperature_range_high: mi.high, idle_temperature: 0, standby_temperature_delta: -5,
      chamber_temperature: 0, overall_chamber_temperature: 0, chamber_minimal_temperature: 0, hold_chamber_temp_for_flat_print: false,
      fan_max_speed: p.fanMax, fan_min_speed: p.fanMin, additional_cooling_fan_speed: 0, max_additional_fan: 0, additional_fan_full_speed_layer: 0,
      close_additional_fan_first_x_layers: 0, first_x_layer_fan_speed: 0, during_print_exhaust_fan_speed: 0, cooling_filter_enabled: false,
      has_tpu_in_first_layer: mat === 'TPU', filament_multitool_ramming: false, is_all_bbl_filament: false,
      enable_pressure_advance: false, pressure_advance: 0.02, scan_first_layer: false, timelapse_type: 0,
      outer_wall_speed: p.speedOuterWall, inner_wall_speed: p.speedInnerWall || p.speedPrint, outer_wall_line_width: lw, perimeter_flow_rate: 1,
      default_acceleration: accel, outer_wall_acceleration: Math.round(accel / 2), machine_max_acceleration_extruding: accel,
      machine_max_acceleration_retracting: accel, machine_max_acceleration_travel: accel, machine_max_acceleration_x: accel,
      machine_max_acceleration_y: accel, machine_max_acceleration_z: 500, machine_max_acceleration_e: 5000, curr_y_acceleration_limit: accel,
      machine_max_speed_x: 500, machine_max_speed_y: 500, machine_max_speed_z: 20, machine_max_speed_e: 30,
      machine_max_jerk_x: 8, machine_max_jerk_y: 8, machine_max_jerk_z: 3, machine_max_jerk_e: 2.5,
      curr_bed_type: p.bedType || 'Textured PEI Plate', spiral_mode: !!p.vase, print_sequence: 'by layer',
      // Druckplatte (Maße des Modells – Werte für das Abtasten nur dort, wo gedruckt wird)
      first_layer_print_min: fMin, first_layer_print_max: fMax, first_layer_print_size: [r3(fMax[0] - fMin[0]), r3(fMax[1] - fMin[1])],
      first_layer_print_min_0: fMin[0], first_layer_print_min_1: fMin[1], first_layer_print_max_0: fMax[0], first_layer_print_max_1: fMax[1],
      first_layer_center_no_wipe_tower: [r3((fMin[0] + fMax[0]) / 2), r3((fMin[1] + fMax[1]) / 2)],
      adaptive_bed_mesh_min: fMin, adaptive_bed_mesh_max: fMax, adaptive_bed_mesh_margin: 0, bed_mesh_probe_count: [5, 5], bed_mesh_algo: 'bicubic',
      print_bed_min: c0, print_bed_max: [c0[0] + bx, c0[1] + by], print_bed_size: [bx, by],
      printable_height: p.bedZ, max_print_height: p.bedZ, max_layer_z: maxZ, max_print_z: maxZ, layer_z: maxZ, layer_num: 0,
      total_layer_count: Math.max(1, Math.round((maxZ - lh0) / lh) + 1), extruded_weight_total: 0, extruded_volume: 0,
      year: now.getFullYear(), month: now.getMonth() + 1, hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds(),
      // Prusa MMU (in einigen Start-Codes abgefragt)
      parking_pos_retraction: 92, extra_loading_move: -2,
      true: true, false: false,
    };
    // Orca-„day“ ist eine Zahl, Cura-„day“ ein Name: Cura-Schreibweise behalten, Zahl unter day_num
    v.day_num = now.getDate();
    if (extra) Object.assign(v, extra);
    return v;
  }

  // --- Makrosprache (Teilmenge von PrusaSlicer/OrcaSlicer, reicht für alle Druckerprofile der Bibliothek) ---
  function tokenize(s) {
    const t = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      let m;
      if ((m = /^(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)/i.exec(s.slice(i)))) { t.push({ k: 'num', v: parseFloat(m[1]) }); i += m[1].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)))) { t.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"' || c === "'") { const j = s.indexOf(c, i + 1); if (j < 0) throw new Error('Text ohne Ende'); t.push({ k: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      if (c === '/' && t.length && t[t.length - 1].k === 'op' && /^[=!]~$/.test(t[t.length - 1].v)) { // Regex nach =~ / !~
        const j = s.indexOf('/', i + 1); if (j < 0) throw new Error('Regex ohne Ende'); t.push({ k: 're', v: s.slice(i + 1, j) }); i = j + 1; continue;
      }
      if ((m = /^(==|!=|<>|<=|>=|&&|\|\||=~|!~|[-+*/%<>!()[\],=?:;])/.exec(s.slice(i)))) { t.push({ k: 'op', v: m[1] }); i += m[1].length; continue; }
      throw new Error('Zeichen „' + c + '“');
    }
    return t;
  }
  class Missing extends Error {}
  function evalExpr(src, vars) {
    const t = tokenize(src);
    let i = 0;
    const peek = (v) => t[i] && (t[i].k === 'op' || t[i].k === 'id') && t[i].v === v;
    const take = (v) => { if (!peek(v)) throw new Error('„' + v + '“ erwartet'); i++; };
    const num = (x) => (typeof x === 'boolean' ? (x ? 1 : 0) : typeof x === 'number' ? x : parseFloat(x));
    const idx = (val, k) => (Array.isArray(val) ? val[Math.max(0, Math.min(val.length - 1, num(k) | 0))] : val);
    const truthy = (x) => (Array.isArray(x) ? truthy(x[0]) : typeof x === 'string' ? x !== '' && x !== '0' && x.toLowerCase() !== 'false' : !!x);
    const scal = (x) => (Array.isArray(x) ? x[0] : x);
    function primary() {
      const tk = t[i];
      if (!tk) throw new Error('Ausdruck unvollständig');
      if (tk.k === 'num' || tk.k === 'str') { i++; return tk.v; }
      if (tk.k === 'op' && tk.v === '(') {
        i++; const a = [ternary()];
        while (peek(',')) { i++; a.push(ternary()); } // Tupel für interpolate_table
        take(')'); return a.length > 1 ? { tuple: a } : a[0];
      }
      if (tk.k === 'op' && (tk.v === '-' || tk.v === '+')) { i++; const x = num(scal(postfix())); return tk.v === '-' ? -x : x; }
      if (tk.k === 'op' && tk.v === '!') { i++; return !truthy(postfix()); }
      if (tk.k === 'id' && tk.v === 'not') { i++; return !truthy(compare()); }
      if (tk.k === 'id') {
        i++;
        if (peek('(')) { // Funktion
          i++; const a = [];
          if (!peek(')')) { a.push(ternary()); while (peek(',')) { i++; a.push(ternary()); } }
          take(')');
          const f = tk.v, n = a.map((x) => num(scal(x)));
          if (f === 'min') return Math.min(...n);
          if (f === 'max') return Math.max(...n);
          if (f === 'int') return Math.trunc(n[0]);
          if (f === 'round') return Math.round(n[0]);
          if (f === 'abs') return Math.abs(n[0]);
          if (f === 'random') return n[0];
          if (f === 'is_nil') return a[0] === undefined || a[0] === null;
          if (f === 'digits' || f === 'zdigits') return n[0].toFixed(a.length > 2 ? n[2] : 0);
          if (f === 'one_of') { const v0 = String(scal(a[0])); return a.slice(1).some((x) => (x && x.re ? new RegExp(x.re).test(v0) : String(scal(x)) === v0)); }
          if (f === 'interpolate_table') {
            const x = n[0], pts = a.slice(1).map((q) => (q && q.tuple ? q.tuple.map((z) => num(z)) : [num(q), num(q)]));
            if (!pts.length) return x;
            if (x <= pts[0][0]) return pts[0][1];
            for (let k = 1; k < pts.length; k++) if (x <= pts[k][0]) return pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * (x - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0]);
            return pts[pts.length - 1][1];
          }
          throw new Missing(f + '()');
        }
        if (!(tk.v in vars) || vars[tk.v] === undefined || vars[tk.v] === null || (typeof vars[tk.v] === 'number' && !isFinite(vars[tk.v]))) throw new Missing(tk.v);
        return vars[tk.v];
      }
      if (tk.k === 're') { i++; return { re: tk.v }; }
      throw new Error('„' + tk.v + '“ unerwartet');
    }
    function postfix() {
      let x = primary();
      while (peek('[')) { i++; const k = ternary(); take(']'); x = idx(x, k); }
      return x;
    }
    function mul() {
      let x = postfix();
      while (peek('*') || peek('/') || peek('%')) {
        const o = t[i++].v; const y = num(scal(postfix())); const a = num(scal(x));
        x = o === '*' ? a * y : o === '/' ? a / y : a % y;
      }
      return x;
    }
    function add() {
      let x = mul();
      while (peek('+') || peek('-')) {
        const o = t[i++].v; const y = mul();
        if (o === '+' && (typeof scal(x) === 'string' && isNaN(+scal(x)) || typeof scal(y) === 'string' && isNaN(+scal(y)))) x = String(scal(x)) + String(scal(y));
        else x = o === '+' ? num(scal(x)) + num(scal(y)) : num(scal(x)) - num(scal(y));
      }
      return x;
    }
    function compare() {
      let x = add();
      for (;;) {
        const o = t[i] && t[i].k === 'op' ? t[i].v : null;
        if (o === '=~' || o === '!~') { i++; const r = primary(); const m = new RegExp(r.re !== undefined ? r.re : String(r)).test(String(scal(x))); x = o === '=~' ? m : !m; continue; }
        if (!['==', '!=', '<>', '<', '>', '<=', '>='].includes(o)) return x;
        i++;
        const y = add(); const a = scal(x), b = scal(y);
        const numeric = !(typeof a === 'string' && isNaN(+a)) && !(typeof b === 'string' && isNaN(+b));
        const A = numeric ? num(a) : String(a), B = numeric ? num(b) : String(b);
        x = o === '==' ? A === B : o === '!=' || o === '<>' ? A !== B : o === '<' ? A < B : o === '>' ? A > B : o === '<=' ? A <= B : A >= B;
      }
    }
    function and() { let x = compare(); while (peek('and') || peek('&&')) { i++; const y = compare(); x = truthy(x) && truthy(y); } return x; }
    function or() { let x = and(); while (peek('or') || peek('||')) { i++; const y = and(); x = truthy(x) || truthy(y); } return x; }
    function ternary() { const c = or(); if (!peek('?')) return c; i++; const a = ternary(); take(':'); const b = ternary(); return truthy(c) ? a : b; }
    // Anweisungen: local/global name = Ausdruck; mehrere durch ; getrennt; Ergebnis = letzter Ausdruck
    let out = '';
    while (i < t.length) {
      if (peek(';')) { i++; continue; }
      if ((peek('local') || peek('global')) && t[i + 1] && t[i + 1].k === 'id') {
        i++; const name = t[i++].v; take('='); vars[name] = ternary(); out = ''; continue;
      }
      if (t[i].k === 'id' && t[i + 1] && t[i + 1].k === 'op' && (t[i + 1].v === '=' || t[i + 1].v === '[')) { // Zuweisung: name = …, name[i] = …
        let j = i + 1;
        if (t[j].v === '[') { let d = 0; for (; j < t.length; j++) { if (t[j].v === '[') d++; else if (t[j].v === ']' && --d === 0) { j++; break; } } }
        if (t[j] && t[j].k === 'op' && t[j].v === '=') {
          const name = t[i].v; const indexed = j > i + 1; i = j + 1; const val = ternary();
          if (!indexed) vars[name] = val; else if (!(name in vars)) vars[name] = val; // Einzelwert je Extruder (hier nur einer)
          out = ''; continue;
        }
      }
      out = ternary();
    }
    return { value: out, truthy: truthy(out) };
  }
  function fmtValue(x) {
    if (Array.isArray(x)) return x.map(fmtValue).join(',');
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'number') return Number.isInteger(x) ? String(x) : String(+x.toFixed(4));
    return String(x);
  }
  // Text mit Makros auswerten → { code, missing }
  function fillPlaceholders(code, p, extra) {
    const vars = placeholderValues(p, extra);
    const missing = [];
    const src = String(code || '');
    // 1) in Stücke zerlegen: Text und {…}-Blöcke (ohne Verschachtelung; {{ }} kommen in Profilen nicht vor)
    const parts = [];
    let pos = 0;
    const re = /\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) { if (m.index > pos) parts.push({ text: src.slice(pos, m.index) }); parts.push({ expr: m[1], raw: m[0] }); pos = re.lastIndex; }
    if (pos < src.length) parts.push({ text: src.slice(pos) });
    // 2) Bedingungen + Ausdrücke
    const out = [];
    const stack = []; // { active: Bereich wird ausgegeben, done: ein Zweig war schon wahr, parent: übergeordnet aktiv }
    const active = () => !stack.length || stack[stack.length - 1].active;
    const cond = (e) => {
      try { return evalExpr(e, vars).truthy; } catch (err) { missing.push(err instanceof Missing ? err.message : '{if ' + e + '}'); return false; }
    };
    for (const pt of parts) {
      if (pt.text !== undefined) { if (active()) out.push(pt.text); continue; }
      const e = pt.expr.trim();
      let mm;
      if ((mm = /^if\b([\s\S]*)$/.exec(e))) { const par = active(); const c = par && cond(mm[1]); stack.push({ active: par && c, done: c, parent: par }); continue; }
      if ((mm = /^(?:elsif|elseif|elif)\b([\s\S]*)$/.exec(e))) {
        const s = stack[stack.length - 1]; if (!s) { missing.push(pt.raw); continue; }
        if (s.done || !s.parent) s.active = false; else { const c = cond(mm[1]); s.active = c; s.done = c; }
        continue;
      }
      if (e === 'else') { const s = stack[stack.length - 1]; if (!s) { missing.push(pt.raw); continue; } s.active = s.parent && !s.done; s.done = true; continue; }
      if (e === 'endif') { if (!stack.pop()) missing.push(pt.raw); continue; }
      if (!active()) continue;
      // Cura: {name, extruder_nr}
      const cura = /^([a-z_][a-z0-9_]*)\s*,\s*[a-z0-9_]+$/i.exec(e);
      try {
        const r = evalExpr(cura ? cura[1] : e, vars);
        out.push(fmtValue(r.value));
      } catch (err) {
        missing.push(err instanceof Missing ? err.message : pt.raw);
        out.push(pt.raw);
      }
    }
    if (stack.length) missing.push('{if} ohne {endif}');
    // 3) alte Schreibweise [name], [name_0], [name[0]]
    const s = out.join('').replace(/\[([a-z_][a-z0-9_]*?)(?:_(\d+)|\[([a-z0-9_]+)\])?\]/g, (all, k, n, ix) => {
      let key = k, val = vars[k];
      if (val === undefined && n !== undefined) { key = k + '_' + n; val = vars[key]; }
      else if (n !== undefined && Array.isArray(val)) val = val[+n] !== undefined ? val[+n] : val[0];
      if (ix !== undefined && val !== undefined) { const j = /^\d+$/.test(ix) ? +ix : vars[ix]; val = Array.isArray(val) ? val[j | 0] : val; }
      if (val !== undefined && val !== null && !(typeof val === 'number' && !isFinite(val))) return fmtValue(val);
      missing.push(k);
      return all;
    });
    return { code: s, missing };
  }

  // ---------- Profil → CuraEngine ----------
  // Profil: einfache, gut lesbare Werte (mm, °C, mm/s, %) – die Oberfläche (Regler) arbeitet nur damit.
  function curaSettings(p) {
    const start = fillPlaceholders(p.startGcode, p);
    const end = fillPlaceholders(p.endGcode, p);
    // CuraEngine schreibt absolute Extrusion (M82). Viele Start-Codes (auch Anycubic) schalten auf relativ (M83) um →
    // am Ende des Start-Codes zwingend zurück auf absolut, sonst würde der Drucker viel zu viel Filament fördern.
    // 10p: relative Extrusion (Bambu, viele Klipper-Drucker: so erwarten es Start-/Schicht-Code) → CuraEngine schreibt dann selbst relativ (M83)
    const rel = !!p.relativeE;
    const startCode = start.code.replace(/\s+$/, '') + '\nG92 E0 ; ScriptSCAD: Extruder auf 0\n' + (rel ? 'M83 ; ScriptSCAD: relative Extrusion' : 'M82 ; ScriptSCAD: absolute Extrusion (CuraEngine)');
    // Heizt der Start-Code selbst (M109/M190 oder Temperatur-Platzhalter), schreibt CuraEngine kein eigenes Aufheizen davor (wie Cura)
    const cmds = String(p.startGcode || '').split('\n').map((l) => l.split(';')[0].trim()).filter(Boolean);
    const macro = (l) => /^[A-Z][A-Z0-9_]*[A-Z_]\b/.test(l) && !/^[GMT]\d/.test(l); // Klipper-/Firmware-Makro (PRINT_START …)
    const heatsNozzle = cmds.some((l) => /^M109\b/i.test(l) || (macro(l) && (/temperature/i.test(l) || /EXTRUDER|HOTEND|NOZZLE/.test(l))));
    const heatsBed = cmds.some((l) => /^M190\b/i.test(l) || (macro(l) && (/bed_temp|plate_temp/i.test(l) || /BED/.test(l))));
    const g = {
      machine_name: p.name, machine_width: p.bedX, machine_depth: p.bedY, machine_height: p.bedZ,
      machine_center_is_zero: !!p.centerZero, machine_shape: p.round ? 'elliptic' : 'rectangular', machine_heated_bed: p.heatedBed !== false,
      machine_gcode_flavor: p.flavor || 'RepRap (Marlin/Sprinter)',
      machine_start_gcode: startCode, machine_end_gcode: end.code, machine_extruder_count: 1,
      layer_height: p.layerHeight, layer_height_0: p.layerHeight0, line_width: p.lineWidth,
      wall_line_count: p.walls, top_layers: p.topLayers, bottom_layers: p.bottomLayers,
      infill_sparse_density: p.infill, infill_pattern: p.infillPattern || 'grid',
      speed_print: p.speedPrint, speed_wall_0: p.speedOuterWall, speed_wall_x: p.speedInnerWall || p.speedPrint, speed_infill: p.speedInfill,
      speed_topbottom: p.speedTopBottom || p.speedOuterWall, speed_support: p.speedPrint, speed_layer_0: p.speedFirstLayer, speed_print_layer_0: p.speedFirstLayer,
      speed_travel_layer_0: Math.min(p.travelSpeed, 100), speed_travel: p.travelSpeed,
      retraction_enable: p.retract > 0, retraction_amount: p.retract, retraction_speed: p.retractSpeed,
      retraction_retract_speed: p.retractSpeed, retraction_prime_speed: Math.min(p.retractSpeed, 60), retraction_hop_enabled: p.zHop > 0, retraction_hop: p.zHop || 0.2,
      material_print_temperature: p.nozzleTemp, material_print_temperature_layer_0: p.nozzleTemp0, material_initial_print_temperature: p.nozzleTemp0,
      material_final_print_temperature: p.nozzleTemp, material_bed_temperature: p.bedTemp, material_bed_temperature_layer_0: p.bedTemp0,
      cool_fan_enabled: p.fanMax > 0, cool_fan_speed: p.fanMax, cool_fan_speed_min: p.fanMin, cool_fan_speed_max: p.fanMax,
      cool_fan_full_layer: 2, cool_min_layer_time: p.minLayerTime || 8,
      support_enable: !!p.support, support_angle: p.supportAngle || 50, support_type: p.supportType === 'everywhere' ? 'everywhere' : 'buildplate',
      adhesion_type: p.adhesion || 'skirt', skirt_line_count: 1, skirt_gap: 3, brim_width: p.brimWidth || 5,
      acceleration_enabled: false, jerk_enabled: false,
      relative_extrusion: rel, material_print_temp_prepend: !heatsNozzle, material_bed_temp_prepend: !heatsBed,
      // 10f: Naht („back“ = hinten: Lage relativ zur Objektmitte, weit nach hinten), Bügeln, Vasen-Modus
      z_seam_type: p.seamType || 'shortest', z_seam_relative: true, z_seam_x: 0, z_seam_y: p.bedY || 300,
      ironing_enabled: !!p.ironing, ironing_line_spacing: p.ironingSpacing || 0.1, ironing_flow: p.ironingFlow || 10, ironing_only_highest_layer: false,
      magic_spiralize: !!p.vase,
    };
    // Vasen-Modus: eine Wand, keine Decke/Füllung/Stützen (wie Cura beim Einschalten)
    if (p.vase) Object.assign(g, { wall_line_count: 1, top_layers: 0, infill_sparse_density: 0, support_enable: false });
    const e = { machine_nozzle_size: p.nozzle, material_diameter: p.filamentDiameter || 1.75, extruder_nr: 0 };
    // Unbekannte Platzhalter in Befehlszeilen (nicht in Kommentaren) → Fehler statt fehlerhaftem G-Code
    const bad = [];
    for (const code of [start.code, end.code]) for (const line of code.split('\n')) {
      const cmd = line.split(';')[0];
      const m = cmd.match(/\{[a-z0-9_]+[^}]*\}|\[[a-z0-9_]+\]/g);
      if (m) bad.push(...m);
    }
    return { global: g, extruder: e, missing: start.missing.concat(end.missing), unresolved: bad };
  }

  // Eigene Druckerdefinition (erbt von fdmprinter/fdmextruder)
  function definitions(p) {
    return {
      'scriptscad_printer.def.json': JSON.stringify({ version: 2, name: p.name, inherits: 'fdmprinter',
        metadata: { visible: true, machine_extruder_trains: { 0: 'scriptscad_extruder_0' } },
        overrides: { machine_extruder_count: { default_value: 1 } } }),
      'scriptscad_extruder_0.def.json': JSON.stringify({ version: 2, name: 'Extruder 1', inherits: 'fdmextruder',
        metadata: { machine: 'scriptscad_printer', position: '0' }, overrides: { extruder_nr: { default_value: 0 } } }),
    };
  }

  function sval(v) { return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v); }
  function commandArgs(settings, defDir, stlPath, outPath) {
    const a = ['slice', '-j', defDir + '/scriptscad_printer.def.json', '-o', outPath];
    for (const [k, v] of Object.entries(settings.global)) a.push('-s', k + '=' + sval(v));
    a.push('-e0');
    for (const [k, v] of Object.entries(settings.extruder)) a.push('-s', k + '=' + sval(v));
    a.push('-l', stlPath);
    return a;
  }

  // ---------- G-Code ----------
  function fmtTime(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }
  // Kopf: CuraEngine lässt ;TIME/;Filament/;MIN…/;MAX… als Platzhalter (füllt sonst die Cura-Oberfläche)
  // CuraEngine meldet den Filamentverbrauch als Volumen (mm³) → Länge = Volumen / Querschnitt
  function filamentLength(mm3, diameter) { return mm3 / (Math.PI * Math.pow((diameter || 1.75) / 2, 2)); }
  function finishGcode(gcode, meta, info) {
    const fl = /repetier/i.test(meta.flavor || '') ? 'Repetier' : /reprap \(reprap\)|^reprap$/i.test(meta.flavor || '') ? 'RepRap' : 'Marlin';
    const head = [';FLAVOR:' + fl, ';TIME:' + Math.round(meta.printTime), ';Filament used: ' + (meta.filamentMm / 1000).toFixed(5) + 'm',
      ';Layer height: ' + info.layerHeight, ';Generated with ScriptSCAD Slicer ' + info.version + ' (CuraEngine 4.6.1)',
      ';Printer: ' + info.printer, ';Model: ' + info.model];
    const lines = gcode.split('\n');
    let i = 0;
    while (i < lines.length && (lines[i].startsWith(';') || !lines[i].trim())) i++;
    let body = lines.slice(i);
    const p = info.profile;
    if (p) body = postProcess(body, p, meta, head, info);
    return head.join('\n') + '\n\n' + body.join('\n');
  }
  // 10p: Nachbearbeitung je Drucker – Schicht-G-Code (Orca „layer_change_gcode“), relative Extrusion bis zum Ende, Bambu: Kopfblock + Fortschritt (M73)
  function postProcess(body, p, meta, head, info) {
    const rel = !!p.relativeE;
    // CuraEngine schaltet vor dem End-Code auf absolut (M82) – bei relativer Extrusion erwartet der End-Code M83
    if (rel) for (let k = body.length - 1; k >= 0 && k > body.length - 400; k--) if (/^M82\b/.test(body[k])) { body[k] = 'M83 ; ScriptSCAD: relative Extrusion'; break; }
    const layerIdx = [];
    for (let k = 0; k < body.length; k++) if (body[k].startsWith(';LAYER:')) layerIdx.push(k);
    const total = layerIdx.length;
    if (!total) return body;
    // Z je Schicht (erste Z-Angabe nach ;LAYER:) und Zeit am Schichtende (;TIME_ELAPSED:)
    const zOf = layerIdx.map((k, n) => {
      const end = n + 1 < total ? layerIdx[n + 1] : body.length;
      for (let j = k; j < end; j++) { const m = /^G[01]\b[^;]*\bZ(-?[\d.]+)/.exec(body[j]); if (m) return +m[1]; }
      return null;
    });
    for (let n = 0; n < total; n++) if (zOf[n] == null) zOf[n] = n ? zOf[n - 1] : (p.layerHeight0 || 0.2);
    const maxZ = Math.max.apply(null, zOf);
    const elapsed = [];
    let last = 0;
    for (let n = 0; n < total; n++) {
      elapsed.push(last); // Zeit zu Beginn der Schicht n
      const end = n + 1 < total ? layerIdx[n + 1] : body.length;
      for (let j = layerIdx[n]; j < end; j++) if (body[j].startsWith(';TIME_ELAPSED:')) last = +body[j].slice(14) || last;
    }
    const totalTime = Math.max(meta.printTime || last, 1);
    const code = [p.beforeLayerGcode, p.layerGcode].filter((c) => c && String(c).trim()).join('\n');
    const out = [];
    let prev = 0;
    for (let n = 0; n < total; n++) {
      out.push.apply(out, body.slice(prev, layerIdx[n] + 1));
      prev = layerIdx[n] + 1;
      if (p.bambu) out.push('M73 P' + Math.floor(elapsed[n] / totalTime * 100) + ' R' + Math.max(0, Math.round((totalTime - elapsed[n]) / 60)));
      if (code) {
        const r = fillPlaceholders(code, p, { layer_num: n, layer_z: +zOf[n].toFixed(3), total_layer_count: total, max_layer_z: +maxZ.toFixed(3) });
        let ins = r.code.replace(/\s+$/, '').split('\n');
        if (!rel) ins = ins.map((l) => (/^\s*G92\s+E/i.test(l) ? '; ' + l + ' (ScriptSCAD: entfällt bei absoluter Extrusion)' : l));
        out.push.apply(out, ins);
      }
    }
    out.push.apply(out, body.slice(prev));
    if (p.bambu) {
      out.push('M73 P100 R0');
      const t = Math.round(meta.printTime || 0), hms = Math.floor(t / 3600) + 'h ' + Math.floor((t % 3600) / 60) + 'm ' + (t % 60) + 's';
      const mi = MATERIAL_INFO[p.material] || MATERIAL_INFO.PLA;
      const dia = p.filamentDiameter || 1.75, len = meta.filamentMm || 0, vol = len * Math.PI * dia * dia / 4 / 1000;
      // Bambu-Drucker lesen diesen Kopf (Schichtzahl, Zeit, Filament) für die Anzeige
      head.push('; HEADER_BLOCK_START', '; generated by ScriptSCAD Slicer ' + info.version + ' (CuraEngine 4.6.1)',
        '; model printing time: ' + hms + '; total estimated time: ' + hms, '; total layer number: ' + total,
        '; total filament length [mm] : ' + len.toFixed(2), '; total filament volume [cm^3] : ' + vol.toFixed(2),
        '; total filament weight [g] : ' + (vol * mi.density).toFixed(2), '; filament_density: ' + mi.density, '; filament_diameter: ' + dia,
        '; max_z_height: ' + maxZ.toFixed(2), '; HEADER_BLOCK_END');
      out.unshift('M73 P0 R' + Math.round(totalTime / 60));
    }
    return out;
  }
  // ---------- Bambu Lab: .gcode.3mf (10p) ----------
  // Bambu-Drucker drucken von der SD-Karte (bzw. per Bambu Studio) Dateien „<Name>.gcode.3mf“: ein 3MF-Paket (ZIP) mit dem G-Code unter
  // Metadata/plate_1.gcode, dessen MD5-Prüfsumme (Großbuchstaben, wie Bambu Studio/OrcaSlicer) und Metadata/slice_info.config
  // (Druckermodell-Kennung, Düse, Zeit, Gewicht, Filament). Aufbau nach OrcaSlicer src/libslic3r/Format/bbs_3mf.cpp.
  function md5(bytes) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const n = bytes.length, total = ((n + 8) >> 6) + 1;
    const W = new Uint32Array(total * 16);
    for (let i = 0; i < n; i++) W[i >> 2] |= bytes[i] << ((i % 4) * 8);
    W[n >> 2] |= 0x80 << ((n % 4) * 8);
    W[total * 16 - 2] = (n * 8) >>> 0; W[total * 16 - 1] = Math.floor(n / 536870912) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < W.length; o += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const tmp = D; D = C; C = B;
        const x = (A + F + K[i] + W[o + g]) >>> 0, sh = S[(i >> 4) * 4 + (i % 4)];
        B = (B + ((x << sh) | (x >>> (32 - sh)))) >>> 0; A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    let hex = '';
    for (const v of [a0, b0, c0, d0]) for (let k = 0; k < 4; k++) hex += ((v >>> (k * 8)) & 255).toString(16).padStart(2, '0');
    return hex.toUpperCase();
  }
  // gcode: Text; info: { modelId, nozzle, printTime (s), weight (g), lengthM, material, color, title, png (Uint8Array|null), supportUsed }; zip: SCADExport.zip
  function bambu3mf(gcode, info, zip) {
    const enc = (s) => new TextEncoder().encode(s);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const g = enc(gcode);
    const sum = md5(g);
    const mat = String(info.material || 'PLA');
    const mi = MATERIAL_INFO[mat] || MATERIAL_INFO.PLA;
    const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
      ' <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n';
    const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
      ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
      (info.png ? ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n' : '') +
      '</Relationships>\n';
    const model = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n' +
      ' <metadata name="Application">ScriptSCAD Slicer</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
      ' <metadata name="Title">' + esc(info.title || 'ScriptSCAD') + '</metadata>\n <resources/>\n <build/>\n</model>\n';
    const t = Math.round(info.printTime || 0);
    const slice = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
      '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="01.10.00.00"/>\n  </header>\n  <plate>\n' +
      '    <metadata key="index" value="1"/>\n' +
      '    <metadata key="printer_model_id" value="' + esc(info.modelId) + '"/>\n' +
      '    <metadata key="nozzle_diameters" value="' + (info.nozzle || 0.4) + '"/>\n' +
      '    <metadata key="timelapse_type" value="0"/>\n' +
      '    <metadata key="prediction" value="' + t + '"/>\n' +
      '    <metadata key="weight" value="' + (info.weight || 0).toFixed(2) + '"/>\n' +
      '    <metadata key="outside" value="false"/>\n' +
      '    <metadata key="support_used" value="' + (info.supportUsed ? 'true' : 'false') + '"/>\n' +
      '    <metadata key="label_object_enabled" value="false"/>\n' +
      '    <filament id="1" tray_info_idx="' + mi.id + '" type="' + esc(mat) + '" color="' + esc(info.color || '#FFFFFF') + '" used_m="' + (info.lengthM || 0).toFixed(2) +
      '" used_g="' + (info.weight || 0).toFixed(2) + '"/>\n  </plate>\n</config>\n';
    const settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n' +
      '    <metadata key="locked" value="false"/>\n    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>\n' +
      (info.png ? '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n' : '') + '  </plate>\n</config>\n';
    const files = [['[Content_Types].xml', enc(types)], ['_rels/.rels', enc(rels)], ['3D/3dmodel.model', enc(model)],
      ['Metadata/plate_1.gcode', g], ['Metadata/plate_1.gcode.md5', enc(sum)], ['Metadata/model_settings.config', enc(settings)],
      ['Metadata/slice_info.config', enc(slice)]];
    if (info.png) files.push(['Metadata/plate_1.png', info.png]);
    return { bytes: zip(files), md5: sum };
  }
  // Filamentgewicht in g (für Anzeige/Bambu-3MF)
  function filamentWeight(mm, diameter, mat) { const mi = MATERIAL_INFO[mat] || MATERIAL_INFO.PLA; return mm * Math.PI * Math.pow((diameter || 1.75) / 2, 2) / 1000 * mi.density; }

  // In Ebenen zerlegen: Start-Zeilennummer, Z, Bahnen (Typ + Punkte) für die Vorschau
  function parseLayers(gcode) {
    const lines = gcode.split('\n');
    const layers = [];
    let cur = null, type = 'TRAVEL', x = 0, y = 0, z = 0, e = 0, rel = false, path = null;
    function flush() { if (path && path.pts.length > 3) cur.paths.push(path); path = null; }
    for (let n = 0; n < lines.length; n++) {
      const l = lines[n];
      if (l.charCodeAt(0) === 59) { // ;
        if (l.startsWith(';LAYER:')) { flush(); cur = { index: +l.slice(7), line: n, z: z, paths: [] }; layers.push(cur); }
        else if (l.startsWith(';TYPE:')) { flush(); type = l.slice(6).trim(); }
        continue;
      }
      const c = l.split(';')[0].trim();
      if (!c) continue;
      const cmd = c.split(/\s+/)[0];
      if (cmd === 'M82') { rel = false; continue; }
      if (cmd === 'M83') { rel = true; continue; }
      if (cmd === 'G92') { const m = /E(-?[\d.]+)/.exec(c); if (m) e = +m[1]; continue; }
      if (cmd !== 'G0' && cmd !== 'G1') continue;
      let nx = x, ny = y, nz = z, ne = null;
      for (const w of c.split(/\s+/).slice(1)) {
        const k = w[0], v = parseFloat(w.slice(1));
        if (k === 'X') nx = v; else if (k === 'Y') ny = v; else if (k === 'Z') nz = v; else if (k === 'E') ne = v;
      }
      const extruding = ne !== null && (rel ? ne > 0 : ne > e) && (nx !== x || ny !== y);
      if (ne !== null) e = rel ? e + ne : ne;
      if (nz !== z) { z = nz; if (cur && !cur.paths.length && !path) cur.z = z; }
      if (cur) {
        if (extruding) {
          if (!path || path.type !== type) { flush(); path = { type, pts: [x, y] }; }
          path.pts.push(nx, ny);
        } else flush();
      }
      x = nx; y = ny;
    }
    flush();
    for (const L of layers) if (!L.z) L.z = z;
    return layers;
  }

  // Druckbahnen für die 3D-Vorschau in zeitlicher Reihenfolge (nur Extrusion wird gezeichnet, Leerfahrten zählen zur Zeit).
  // Zeit je Bewegung = Strecke / Vorschub; am Ende auf die Druckzeit von CuraEngine skaliert (berücksichtigt Beschleunigung grob).
  const TYPES = ['WALL-OUTER', 'WALL-INNER', 'SKIN', 'FILL', 'SKIRT', 'SUPPORT', 'SUPPORT-INTERFACE', 'PRIME-TOWER', 'OTHER'];
  function buildToolpaths(gcode, printTime) {
    const lines = gcode.split('\n');
    let cap = 1 << 16, n = 0;
    let pos = new Float32Array(cap * 6), typ = new Uint8Array(cap), tim = new Float32Array(cap), lno = new Uint32Array(cap);
    function grow() {
      cap *= 2;
      const p2 = new Float32Array(cap * 6); p2.set(pos); pos = p2;
      const t2 = new Uint8Array(cap); t2.set(typ); typ = t2;
      const m2 = new Float32Array(cap); m2.set(tim); tim = m2;
      const l2 = new Uint32Array(cap); l2.set(lno); lno = l2;
    }
    const layerStart = [], layerLine = [], layerZ = [], layerTime = [];
    let x = 0, y = 0, z = 0, e = 0, f = 1800, rel = false, t = 0, type = 8, inLayers = false;
    for (let li = 0; li < lines.length; li++) {
      const l = lines[li];
      if (l.charCodeAt(0) === 59) {
        if (l.startsWith(';LAYER:')) { inLayers = true; layerStart.push(n); layerLine.push(li); layerZ.push(z); layerTime.push(t); }
        else if (l.startsWith(';TYPE:')) { const k = TYPES.indexOf(l.slice(6).trim()); type = k < 0 ? 8 : k; }
        continue;
      }
      const c = l.split(';')[0].trim();
      if (!c) continue;
      const sp = c.split(/\s+/), cmd = sp[0];
      if (cmd === 'M82') { rel = false; continue; }
      if (cmd === 'M83') { rel = true; continue; }
      if (cmd === 'G92') { for (const w of sp) if (w[0] === 'E') e = parseFloat(w.slice(1)); continue; }
      if (cmd !== 'G0' && cmd !== 'G1') continue;
      let nx = x, ny = y, nz = z, ne = null;
      for (let k = 1; k < sp.length; k++) {
        const w = sp[k], v = parseFloat(w.slice(1));
        switch (w[0]) { case 'X': nx = v; break; case 'Y': ny = v; break; case 'Z': nz = v; break; case 'E': ne = v; break; case 'F': f = v; break; }
      }
      const dx = nx - x, dy = ny - y, dz = nz - z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const de = ne === null ? 0 : rel ? ne : ne - e;
      if (ne !== null) e = rel ? e + ne : ne;
      t += f > 0 ? (Math.max(dist, Math.abs(de)) / f) * 60 : 0;
      if (nz !== z && inLayers && layerStart.length && layerStart[layerStart.length - 1] === n) layerZ[layerZ.length - 1] = nz;
      if (inLayers && de > 0 && (dx || dy)) {
        if (n >= cap) grow();
        const o = n * 6;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; pos[o + 3] = nx; pos[o + 4] = ny; pos[o + 5] = nz;
        typ[n] = type; tim[n] = t; lno[n] = li;
        n++;
      }
      x = nx; y = ny; z = nz;
    }
    const scale = printTime > 0 && t > 0 ? printTime / t : 1;
    for (let i = 0; i < n; i++) tim[i] *= scale;
    for (let i = 0; i < layerTime.length; i++) layerTime[i] *= scale;
    return { count: n, pos: pos.subarray(0, n * 6), type: typ.subarray(0, n), time: tim.subarray(0, n), line: lno.subarray(0, n),
      layerStart, layerLine, layerZ, layerTime, totalTime: t * scale, types: TYPES };
  }
  // Index des letzten Bahnstücks, das bis zur Zeit t fertig ist (+1) – binäre Suche
  function segmentAt(tp, t) {
    let lo = 0, hi = tp.count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tp.time[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  }
  function layerOfSegment(tp, seg) {
    let lo = 0, hi = tp.layerStart.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tp.layerStart[m] < seg || (tp.layerStart[m] === seg && seg === 0)) lo = m; else hi = m - 1; }
    return lo;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s2).padStart(2, '0');
  }

  // ---------- 10j: OBJ, 3MF einlesen; Netz prüfen und reparieren ----------
  const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [, ''])[1].toLowerCase();
  // OBJ (Text): v x y z · f a b c … (Vielecke als Fächer, Indizes mit /…, negative Indizes relativ)
  function parseObj(bytes) {
    const text = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('utf8');
    const v = [], out = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'v' && t.length >= 4) v.push([+t[1], +t[2], +t[3]]);
      else if (t[0] === 'f' && t.length >= 4) {
        const idx = t.slice(1).map((x) => { const i = parseInt(x.split('/')[0], 10); return i < 0 ? v.length + i : i - 1; });
        for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) { const p = v[i]; if (!p) throw new Error('OBJ ungültig (Punkt ' + (i + 1) + ' fehlt)'); out.push(p[0], p[1], p[2]); }
      }
    }
    if (!out.length) throw new Error('OBJ enthält keine Flächen');
    return new Float32Array(out);
  }
  // ZIP lesen (zentrales Verzeichnis) → { Name: Uint8Array } (nur „gespeichert“ und „deflate“; deflate über DecompressionStream)
  async function unzip(bytes, want) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('3MF ungültig (kein ZIP)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (want && !want(name)) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (method === 0) files[name] = data;
      else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('3MF: Entpacken wird hier nicht unterstützt');
        const ds = new DecompressionStream('deflate-raw');
        const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
        files[name] = new Uint8Array(buf);
      } else throw new Error('3MF: Packverfahren ' + method + ' unbekannt');
    }
    return files;
  }
  // 3MF: alle Netze der „build“-Liste mit ihren Transformationen (auch Komponenten), Einheit → mm
  async function parse3mf(bytes) {
    const files = await unzip(bytes, (n) => /\.model$/i.test(n));
    const names = Object.keys(files);
    if (!names.length) throw new Error('3MF enthält kein Modell');
    const main = names.find((n) => /^3D\/3dmodel\.model$/i.test(n)) || names[0];
    const xml = new TextDecoder().decode(files[main]);
    const unit = (/<model[^>]*\sunit="([a-z]+)"/i.exec(xml) || [, 'millimeter'])[1].toLowerCase();
    const f = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] || 1;
    const attr = (tag, a) => { const m = new RegExp('\\s' + a + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
    const mat = (t) => { if (!t) return null; const v = t.trim().split(/\s+/).map(Number); return v.length === 12 ? v : null; };
    const objects = {};
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let m;
    while ((m = objRe.exec(xml))) {
      const id = attr(m[1], 'id');
      const body = m[2];
      const verts = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      let vm;
      while ((vm = vRe.exec(body))) verts.push([+attr(vm[1], 'x'), +attr(vm[1], 'y'), +attr(vm[1], 'z')]);
      const tris = [];
      const tRe = /<triangle\b([^>]*)\/?>/g;
      let tm;
      while ((tm = tRe.exec(body))) tris.push([+attr(tm[1], 'v1'), +attr(tm[1], 'v2'), +attr(tm[1], 'v3')]);
      const comps = [];
      const cRe = /<component\b([^>]*)\/?>/g;
      let cm;
      while ((cm = cRe.exec(body))) comps.push({ id: attr(cm[1], 'objectid'), m: mat(attr(cm[1], 'transform')) });
      objects[id] = { verts, tris, comps };
    }
    const apply = (M, p) => (M ? [M[0] * p[0] + M[3] * p[1] + M[6] * p[2] + M[9], M[1] * p[0] + M[4] * p[1] + M[7] * p[2] + M[10], M[2] * p[0] + M[5] * p[1] + M[8] * p[2] + M[11]] : p);
    const comb = (A, B) => { // erst B, dann A (beide 3×4, Zeilen-Vektor-Form wie 3MF)
      if (!A) return B; if (!B) return A;
      const r = new Array(12);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) r[i * 3 + j] = B[i * 3] * A[j] + B[i * 3 + 1] * A[3 + j] + B[i * 3 + 2] * A[6 + j];
      for (let j = 0; j < 3; j++) r[9 + j] = B[9] * A[j] + B[10] * A[3 + j] + B[11] * A[6 + j] + A[9 + j];
      return r;
    };
    const out = [];
    const emit = (id, M, depth) => {
      const o = objects[id];
      if (!o || depth > 10) return;
      for (const t of o.tris) for (const i of t) { const p = apply(M, o.verts[i] || [0, 0, 0]); out.push(p[0] * f, p[1] * f, p[2] * f); }
      for (const c of o.comps) emit(c.id, comb(M, c.m), depth + 1);
    };
    const itemRe = /<item\b([^>]*)\/?>/g;
    let im, items = 0;
    while ((im = itemRe.exec(xml))) { items++; emit(attr(im[1], 'objectid'), mat(attr(im[1], 'transform')), 0); }
    if (!items) for (const id of Object.keys(objects)) emit(id, null, 0);
    if (!out.length) throw new Error('3MF enthält keine Dreiecke');
    return new Float32Array(out);
  }
  // Netz nach Dateiendung einlesen (3MF braucht Entpacken → immer als Promise)
  async function parseMesh(bytes, name) {
    const e = extOf(name);
    if (e === '3mf') return parse3mf(bytes);
    if (e === 'obj') return parseObj(bytes);
    return parseStl(bytes);
  }
  // Prüfen + Reparieren: Punkte verschweißen (0,001 mm), entartete/doppelte Dreiecke entfernen, Ausrichtung einheitlich (nach außen),
  // Löcher (offene Kanten-Ringe bis 200 Kanten) mit Fächern schließen. → { tri, report: { welded, degenerate, duplicate, flipped, holes, openEdges, changed } }
  function repairMesh(tri) {
    const n0 = tri.length / 9;
    const key = (x, y, z) => Math.round(x * 1000) + ',' + Math.round(y * 1000) + ',' + Math.round(z * 1000);
    const ids = new Map(), P = [];
    const vid = (x, y, z) => { const k = key(x, y, z); let i = ids.get(k); if (i === undefined) { i = P.length; ids.set(k, i); P.push([x, y, z]); } return i; };
    let F = [];
    let degenerate = 0, duplicate = 0;
    const seenF = new Set();
    for (let t = 0; t < n0; t++) {
      const o = t * 9;
      const a = vid(tri[o], tri[o + 1], tri[o + 2]), b = vid(tri[o + 3], tri[o + 4], tri[o + 5]), c = vid(tri[o + 6], tri[o + 7], tri[o + 8]);
      if (a === b || b === c || a === c) { degenerate++; continue; }
      const A = P[a], B = P[b], C = P[c];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-12) { degenerate++; continue; }
      const sk = [a, b, c].sort((x, y) => x - y).join(',');
      if (seenF.has(sk)) { duplicate++; continue; }
      seenF.add(sk);
      F.push([a, b, c]);
    }
    const welded = n0 * 3 - P.length;
    // Kanten → Flächen
    const edgeMap = () => {
      const m = new Map();
      F.forEach((f, fi) => { for (let k = 0; k < 3; k++) { const a = f[k], b = f[(k + 1) % 3]; const ek = a < b ? a + '_' + b : b + '_' + a; let l = m.get(ek); if (!l) m.set(ek, (l = [])); l.push(fi); } });
      return m;
    };
    // Ausrichtung angleichen (Breitensuche über gemeinsame Kanten; gleiche Richtung einer Kante in beiden Flächen = eine ist verkehrt)
    let flipped = 0;
    {
      const em = edgeMap();
      const done = new Uint8Array(F.length);
      const dir = (f, a, b) => { for (let k = 0; k < 3; k++) if (f[k] === a && f[(k + 1) % 3] === b) return 1; return 0; };
      const comps = []; // { list, vol, lo, hi } – erst alle Teilkörper ausrichten, dann über die Richtung entscheiden
      for (let s = 0; s < F.length; s++) {
        if (done[s]) continue;
        done[s] = 1;
        const q = [s];
        const comp = [s];
        while (q.length) {
          const fi = q.pop(), f = F[fi];
          for (let k = 0; k < 3; k++) {
            const a = f[k], b = f[(k + 1) % 3];
            const l = em.get(a < b ? a + '_' + b : b + '_' + a);
            if (!l || l.length !== 2) continue;
            const g = l[0] === fi ? l[1] : l[0];
            if (done[g]) continue;
            if (dir(F[g], a, b)) { F[g] = [F[g][0], F[g][2], F[g][1]]; flipped++; }
            done[g] = 1; q.push(g); comp.push(g);
          }
        }
        let vol = 0;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const fi of comp) {
          const [a, b, c] = F[fi].map((i) => P[i]);
          vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
          for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
        }
        comps.push({ list: comp, vol, lo, hi });
      }
      // Teilkörper nach innen gedreht (Volumen negativ) → umdrehen, AUSSER er liegt in einem anderen Körper: dann ist er ein Hohlraum (bleibt so)
      const inside = (x, y) => x !== y && x.lo.every((v, k) => v >= y.lo[k] - 1e-6) && x.hi.every((v, k) => v <= y.hi[k] + 1e-6);
      for (const c of comps) {
        if (c.vol >= 0 || comps.some((o) => o.vol > 0 && Math.abs(o.vol) > Math.abs(c.vol) && inside(c, o))) continue;
        for (const fi of c.list) { F[fi] = [F[fi][0], F[fi][2], F[fi][1]]; flipped++; }
      }
    }
    // Löcher: Randkanten (nur einer Fläche zugeordnet) zu Ringen verbinden und mit einem Fächer vom Mittelpunkt schließen
    let holes = 0;
    {
      const em = edgeMap();
      const next = new Map(); // gerichtete Randkante b→a (umgekehrt zur Fläche, damit die neue Fläche passend ausgerichtet ist)
      for (const [ek, l] of em) if (l.length === 1) {
        const f = F[l[0]];
        const [x, y] = ek.split('_').map(Number);
        for (let k = 0; k < 3; k++) { const a = f[k], b = f[(k + 1) % 3]; if ((a === x && b === y) || (a === y && b === x)) { if (!next.has(b)) next.set(b, a); } }
      }
      const used = new Set();
      for (const start of next.keys()) {
        if (used.has(start)) continue;
        const ring = [];
        let v = start;
        while (v !== undefined && !used.has(v) && ring.length < 201) { used.add(v); ring.push(v); v = next.get(v); }
        if (v !== start || ring.length < 3 || ring.length > 200) continue;
        const c = [0, 0, 0];
        for (const i of ring) for (let k = 0; k < 3; k++) c[k] += P[i][k] / ring.length;
        const ci = P.length; P.push(c);
        for (let k = 0; k < ring.length; k++) F.push([ring[k], ring[(k + 1) % ring.length], ci]);
        holes++;
      }
    }
    let openEdges = 0;
    for (const l of edgeMap().values()) if (l.length !== 2) openEdges++;
    const out = new Float32Array(F.length * 9);
    F.forEach((f, i) => { for (let k = 0; k < 3; k++) { const p = P[f[k]]; out[i * 9 + k * 3] = p[0]; out[i * 9 + k * 3 + 1] = p[1]; out[i * 9 + k * 3 + 2] = p[2]; } });
    const report = { triangles: F.length, degenerate, duplicate, flipped, holes, openEdges };
    report.changed = !!(degenerate || duplicate || flipped || holes);
    return { tri: report.changed ? out : tri, report };
  }

  const api = { MATERIAL_INFO, filamentWeight, md5, bambu3mf, evalExpr, parseMesh, parseObj, parse3mf, repairMesh, parseStl, bounds, placeOnBed, fillPlaceholders, curaSettings, definitions, commandArgs, finishGcode, parseLayers, fmtTime, isBinaryStl, filamentLength, cubeStl, cubeTri, centerTri, arrange, checkLayout, mergeObjects, eulerToMat, matToEuler, matMul, alignMat, applyMat, transformTri, components, footCenter, flatFaces, buildToolpaths, segmentAt, layerOfSegment, fmtClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SlicerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
