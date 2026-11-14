// 3D-Ansicht für ScriptSCAD Studio (three.js).
// Wird mit esbuild zu scriptable/ScriptSCAD/app/lib/viewer.js gebündelt (tools/build.mjs).
// Stellt global window.SCADViewer bereit.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); // Puffer behalten: Ansicht als Bild für die KI
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef1f5);

  // OpenSCAD: Z zeigt nach oben
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(60, -80, 60);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, -1.5, 2);
  scene.add(sun);

  let grid = new THREE.GridHelper(200, 20, 0x99a3b0, 0xd0d6de);
  grid.rotation.x = Math.PI / 2; // XY-Ebene
  scene.add(grid);
  // Farben für Hell/Dunkel (Schritt 8a): Hintergrund und Gitter
  function setTheme(t) {
    if (t.bg != null) scene.background = new THREE.Color(t.bg);
    if (t.model != null) { modelHex = t.model; applyColors(); } // 8c: Modellfarbe der Marke (Signal-Orange); 10n: Flächen ohne color()
    if (t.grid1 != null || t.grid2 != null) {
      const g = new THREE.GridHelper(200, 20, t.grid1 != null ? t.grid1 : 0x99a3b0, t.grid2 != null ? t.grid2 : 0xd0d6de);
      g.rotation.x = Math.PI / 2;
      g.scale.copy(grid.scale);
      scene.remove(grid);
      grid.geometry.dispose();
      grid = g;
      scene.add(grid);
    }
    render();
  }
  scene.add(new THREE.AxesHelper(15));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', render);

  const material = new THREE.MeshStandardMaterial({ color: 0xf2b134, metalness: 0.05, roughness: 0.6, flatShading: false });
  let mesh = null;

  // ---------- 10g: Schnittansicht ----------
  // Eine Ebene schneidet das Modell (Teil auf der „positiven“ Seite der Ebene bleibt sichtbar). Die Schnittfläche erscheint als
  // farbige Fläche: das Innere (Rückseiten der Dreiecke) wird einfarbig gezeichnet – bei geschlossenen Körpern sieht das wie eine Füllung aus.
  renderer.localClippingEnabled = true;
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const capMaterial = new THREE.MeshBasicMaterial({ color: 0x2f6fe0, side: THREE.BackSide, clippingPlanes: [clipPlane] });
  let capMesh = null;
  let clip = null; // { axis: 'x'|'y'|'z', t: 0…1 (Lage im Modell), flip }
  function applyClip() {
    const on = !!(clip && mesh);
    material.clippingPlanes = on ? [clipPlane] : null;
    material.needsUpdate = true;
    if (capMesh) { scene.remove(capMesh); capMesh = null; }
    if (!on) return null;
    const b = mesh.geometry.boundingBox;
    const i = { x: 0, y: 1, z: 2 }[clip.axis] || 0;
    const lo = b.min.getComponent(i), hi = b.max.getComponent(i);
    const pos = lo + Math.max(0, Math.min(1, clip.t)) * (hi - lo);
    const n = new THREE.Vector3(); n.setComponent(i, clip.flip ? 1 : -1);
    clipPlane.set(n, clip.flip ? -pos : pos); // sichtbar bleibt: Koordinate ≤ pos (umgekehrt: ≥ pos)
    capMesh = new THREE.Mesh(mesh.geometry, capMaterial);
    capMesh.visible = mesh.visible;
    scene.add(capMesh);
    return { axis: clip.axis, pos, min: lo, max: hi };
  }
  function setClip(c) { clip = c ? Object.assign({}, c) : null; const r = applyClip(); render(); return r; }

  function render() {
    renderer.render(scene, camera);
  }

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false); // Canvas-Größe per CSS (100 %), daher keine Layout-Schleife
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  // keep = true: Blickrichtung des Nutzers beibehalten und nur herauszoomen, wenn das Modell nicht mehr passt
  // (beim Ziehen am Regler – sonst „springt“ die Ansicht bei jedem Zwischenwert)
  function fit(box, keep) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    let dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.15;
    let dir = new THREE.Vector3(1, -1.3, 0.9).normalize();
    if (keep) {
      const off = camera.position.clone().sub(controls.target);
      if (off.length() > 1e-6) {
        dist = Math.max(dist, off.length());
        dir = off.normalize();
      }
    }
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = dist / 100;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    adjustGrid(size);
  }
  function adjustGrid(size) {
    const g = Math.max(10, Math.ceil(Math.max(size.x, size.y) * 1.5 / 10) * 10);
    grid.scale.setScalar(g / 200);
  }

  // 10n: Farben aus color() – je Dreieck [r, g, b] (0…255) oder null (= Modellfarbe der App). Ohne Farben: einfarbig wie bisher.
  let modelHex = 0xf2b134;
  let triColors = null;
  function applyColors() {
    const colored = !!(mesh && triColors && triColors.some((c) => c));
    material.vertexColors = colored;
    material.color.setHex(colored ? 0xffffff : modelHex);
    if (colored) {
      const n = mesh.geometry.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const base = new THREE.Color(modelHex), tmp = new THREE.Color();
      for (let t = 0; t < n / 3; t++) {
        const c = triColors[t];
        const col = c ? tmp.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace) : base;
        for (let k = 0; k < 3; k++) { arr[(t * 3 + k) * 3] = col.r; arr[(t * 3 + k) * 3 + 1] = col.g; arr[(t * 3 + k) * 3 + 2] = col.b; }
      }
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    material.needsUpdate = true;
  }
  // keepView = true: Kamera nicht neu ausrichten (z. B. beim Ziehen am Regler); colors: siehe applyColors
  function showStl(stlText, keepView, colors) {
    const geometry = new STLLoader().parse(stlText);
    geometry.computeVertexNormals();
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    mesh = new THREE.Mesh(geometry, material);
    mesh.visible = !comparing;
    scene.add(mesh);
    triColors = Array.isArray(colors) && colors.length === geometry.attributes.position.count / 3 ? colors : null;
    applyColors();
    geometry.computeBoundingBox();
    if (clip) applyClip(); // 10g: Schnitt bleibt beim neuen Modell erhalten
    fit(geometry.boundingBox, !!keepView);
    render();
    const b = geometry.boundingBox;
    return {
      triangles: geometry.attributes.position.count / 3,
      min: [b.min.x, b.min.y, b.min.z],
      max: [b.max.x, b.max.y, b.max.z],
    };
  }

  // Vergleich (KI-Vorschau): altes Modell als verstecktes Netz, beim Halten des Knopfs statt des neuen gezeigt.
  // Gleiche Kamera → Unterschied direkt sichtbar. Eigene Farbe (grau-blau), damit klar ist, was man sieht.
  const beforeMaterial = new THREE.MeshStandardMaterial({ color: 0x8fa3bf, metalness: 0.05, roughness: 0.6 });
  let beforeMesh = null;
  let comparing = false;
  function setCompare(stlText) {
    if (beforeMesh) { scene.remove(beforeMesh); beforeMesh.geometry.dispose(); beforeMesh = null; }
    comparing = false;
    if (mesh) mesh.visible = true;
    if (stlText) {
      const geometry = new STLLoader().parse(stlText);
      geometry.computeVertexNormals();
      beforeMesh = new THREE.Mesh(geometry, beforeMaterial);
      beforeMesh.visible = false;
      scene.add(beforeMesh);
    }
    render();
    return !!beforeMesh;
  }
  function showCompare(on) {
    if (!beforeMesh) return false;
    comparing = !!on;
    beforeMesh.visible = comparing;
    if (mesh) mesh.visible = !comparing;
    if (capMesh) capMesh.visible = !comparing;
    if (hlMesh) hlMesh.visible = !comparing;
    render();
    return comparing;
  }

  // Hervorhebung des gewählten Objekts: halbdurchsichtig blau, immer sichtbar (auch Löcher im Inneren)
  const hlMaterial = new THREE.MeshStandardMaterial({ color: 0x1f6fff, emissive: 0x0a2a80, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
  let hlMesh = null;
  function showHighlight(stlText) {
    if (hlMesh) { scene.remove(hlMesh); hlMesh.geometry.dispose(); hlMesh = null; }
    if (stlText) {
      const geometry = new STLLoader().parse(stlText);
      geometry.computeVertexNormals();
      hlMesh = new THREE.Mesh(geometry, hlMaterial);
      hlMesh.renderOrder = 10;
      scene.add(hlMesh);
    }
    // Restliches Modell abblenden, solange etwas hervorgehoben ist
    material.transparent = !!hlMesh;
    material.opacity = hlMesh ? 0.35 : 1;
    material.depthWrite = !hlMesh;
    material.needsUpdate = true;
    render();
    return !!hlMesh;
  }

  // ---------- Objekt durch Antippen wählen (7h) ----------
  // Tippen = ein Finger, kaum bewegt (< 8 px), kurz (< 500 ms) – Drehen/Zoomen per OrbitControls bleibt unberührt.
  let tapCb = null;
  const downs = new Map();
  let multi = false;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() }); if (downs.size > 1) multi = true; });
  const up = (e) => {
    const d = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    const wasMulti = multi;
    if (!downs.size) multi = false;
    if (!d || wasMulti || e.type !== 'pointerup' || !tapCb) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 500) return;
    const r = el.getBoundingClientRect();
    tapCb({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 });
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  const raycaster = new THREE.Raycaster();
  // Punkt auf der sichtbaren Modell-Oberfläche unter dem Finger (ndc = -1…1) → [x, y, z] oder null
  function pick(ndc) {
    if (!mesh || !mesh.visible) return null;
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const material0 = mesh.material.side;
    mesh.material.side = THREE.DoubleSide;
    const hit = raycaster.intersectObject(mesh, false)[0];
    mesh.material.side = material0;
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
  }
  // Einzeln gerenderte Objekte (STL je Objekt) → welches liegt mit seiner Oberfläche am nächsten am Punkt?
  let parts = [];
  function setPickParts(stls) {
    parts.forEach((g) => g && g.dispose());
    parts = (stls || []).map((t) => {
      if (!t) return null;
      const g = new STLLoader().parse(t);
      g.computeBoundingBox();
      return g;
    });
    return parts.length;
  }
  function pickPart(pt) {
    const p = new THREE.Vector3(pt[0], pt[1], pt[2]);
    const tri = new THREE.Triangle();
    const q = new THREE.Vector3();
    let best = { index: -1, dist: Infinity };
    parts.forEach((g, i) => {
      if (!g || g.boundingBox.distanceToPoint(p) > best.dist) return;
      const a = g.attributes.position.array;
      for (let k = 0; k < a.length; k += 9) {
        tri.a.set(a[k], a[k + 1], a[k + 2]);
        tri.b.set(a[k + 3], a[k + 4], a[k + 5]);
        tri.c.set(a[k + 6], a[k + 7], a[k + 8]);
        tri.closestPointToPoint(p, q);
        const d = q.distanceTo(p);
        if (d < best.dist) best = { index: i, dist: d };
      }
    });
    return best.index < 0 ? null : best;
  }
  // Bildschirmposition (ndc) eines Punkts – für Tests (Antippen an einer bestimmten Stelle des Modells)
  function project(pt) {
    const v = new THREE.Vector3(pt[0], pt[1], pt[2]).project(camera);
    return { x: v.x, y: v.y };
  }

  if (window.ResizeObserver) new ResizeObserver(resize).observe(container);
  window.addEventListener('resize', resize);
  resize();

  // Für Tests: Farbe des mittleren Pixels direkt nach dem Zeichnen
  function centerPixel() {
    render();
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  }

  return { onTap: (cb) => { tapCb = cb; }, pick, setPickParts, pickPart, project, modelSize: () => (mesh ? mesh.geometry.boundingBox.getSize(new THREE.Vector3()).length() : 0), setTheme, showStl, showHighlight, setCompare, showCompare, isComparing: () => comparing, render, resize, centerPixel, hasHighlight: () => !!hlMesh, snapshotCanvas: () => { render(); return renderer.domElement; }, clearModel: () => { if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; } if (capMesh) { scene.remove(capMesh); capMesh = null; } triColors = null; render(); }, setClip, getClip: () => (clip ? Object.assign({}, clip) : null), isColored: () => !!material.vertexColors };
}

window.SCADViewer = { createViewer };
