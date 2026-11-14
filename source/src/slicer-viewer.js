// 3D-Ansicht für ScriptSCAD Slicer (three.js): Druckbett, Objekte (9e: mehrere, antippen = wählen), Druckbahnen bis zu einem Zeitpunkt.
// Wird mit esbuild zu scriptable/ScriptSCAD/app/slicer/viewer.js gebündelt (tools/build-slicer.mjs). Global window.SlicerViewer.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161615);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  camera.up.set(0, 0, 1); // Z nach oben wie beim Drucker
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, -1.5, 2);
  scene.add(sun);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', render);

  let theme = { bg: 0x161615, bed: 0x242422, grid: 0x3a3a37, edge: 0x6a6a65, model: 0xff4f1a, dim: 0x8a8a84 };
  let bed = { w: 220, d: 220, h: 250, ox: 0, oy: 0, round: false }; // ox/oy: Ecke des Betts (Delta-Drucker: Mitte = 0 → -w/2)
  let bedGroup = null;
  function buildBed() {
    if (bedGroup) { scene.remove(bedGroup); bedGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    bedGroup = new THREE.Group();
    const cx = bed.ox + bed.w / 2, cy = bed.oy + bed.d / 2;
    const plateGeom = bed.round ? new THREE.CircleGeometry(0.5, 96) : new THREE.PlaneGeometry(1, 1);
    const plate = new THREE.Mesh(plateGeom, new THREE.MeshBasicMaterial({ color: theme.bed }));
    plate.scale.set(bed.w, bed.d, 1);
    plate.position.set(cx, cy, -0.05);
    bedGroup.add(plate);
    const pts = [];
    const inside = (x, y) => !bed.round || ((x - cx) / (bed.w / 2)) ** 2 + ((y - cy) / (bed.d / 2)) ** 2 <= 1.0001;
    // Gitter alle 10 mm (beim runden Bett nur innerhalb des Kreises)
    for (let x = Math.ceil(bed.ox / 10) * 10; x <= bed.ox + bed.w + 0.01; x += 10) {
      const h = bed.round ? (bed.d / 2) * Math.sqrt(Math.max(0, 1 - ((x - cx) / (bed.w / 2)) ** 2)) : bed.d / 2;
      if (h > 0) pts.push(x, cy - h, 0, x, cy + h, 0);
    }
    for (let y = Math.ceil(bed.oy / 10) * 10; y <= bed.oy + bed.d + 0.01; y += 10) {
      const h = bed.round ? (bed.w / 2) * Math.sqrt(Math.max(0, 1 - ((y - cy) / (bed.d / 2)) ** 2)) : bed.w / 2;
      if (h > 0 && inside(cx, y)) pts.push(cx - h, y, 0, cx + h, y, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    bedGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: theme.grid })));
    // Bauraum als Drahtrahmen (Quader bzw. Zylinder)
    const vol = bed.round ? new THREE.CylinderGeometry(0.5, 0.5, 1, 64, 1, true) : new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(vol, bed.round ? 89 : 1), new THREE.LineBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.35 }));
    if (bed.round) edges.rotation.x = Math.PI / 2;
    edges.scale.set(bed.w, bed.round ? bed.h : bed.d, bed.round ? bed.d : bed.h);
    edges.position.set(cx, cy, bed.h / 2);
    vol.dispose();
    bedGroup.add(edges);
    scene.add(bedGroup);
  }

  const modelMat = new THREE.MeshStandardMaterial({ color: theme.model, metalness: 0.05, roughness: 0.6 });
  const selMat = new THREE.MeshStandardMaterial({ color: 0x3d7bff, metalness: 0.05, roughness: 0.5 }); // gewählt (wie Studio)
  const badMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c0, metalness: 0, roughness: 0.8, transparent: true, opacity: 0.55 }); // außerhalb/zu hoch
  const objGroup = new THREE.Group();
  scene.add(objGroup);
  let objects = []; // [{ id, mesh, bad }]
  let selected = null;
  let pathsVisible = true;
  // Druckbahnen: eine Geometrie, zwei Ansichten (darunterliegende Schichten gedimmt, aktuelle Schicht hell)
  let paths = null; // { below, current, geom }
  const nozzle = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  nozzle.visible = false;
  scene.add(nozzle);

  function render() { renderer.render(scene, camera); }
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  function fit(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 10);
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.1;
    const dir = new THREE.Vector3(0.35, -1.2, 0.95).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = dist / 200; camera.far = dist * 50;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }
  function fitBed() { fit(new THREE.Box3(new THREE.Vector3(bed.ox, bed.oy, 0), new THREE.Vector3(bed.ox + bed.w, bed.oy + bed.d, Math.min(bed.h, 40)))); }

  function setBed(w, d, h, opt) {
    opt = opt || {};
    bed = { w, d, h, ox: opt.centerZero ? -w / 2 : 0, oy: opt.centerZero ? -d / 2 : 0, round: !!opt.round };
    buildBed();
    placeObjects();
    if (!objects.length) fitBed();
    render();
  }
  function setTheme(t) {
    theme = Object.assign(theme, t);
    scene.background = new THREE.Color(theme.bg);
    modelMat.color.setHex(theme.model);
    if (paths) paths.below.material.color.setHex(theme.dim);
    buildBed();
    render();
  }
  // Objekte: [{ id, tri (Float32Array, Mitte X/Y = 0, Unterseite Z = 0), x, y (relativ zur Bettmitte), bad }]
  // Geometrie wird je id behalten (nur Lage/Farbe ändern sich), opt.fit = Kamera auf alle Objekte richten
  function setObjects(list, opt) {
    const keep = new Map(objects.map((o) => [o.id, o]));
    const next = [];
    for (const o of list) {
      let e = keep.get(o.id);
      if (e) keep.delete(o.id);
      // 9f: gedreht/skaliert → neue Dreiecke (rev zählt hoch) → Geometrie ersetzen
      if (e && e.rev !== o.rev) { objGroup.remove(e.mesh); e.mesh.geometry.dispose(); e = null; }
      if (!e) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.tri), 3));
        g.computeVertexNormals();
        g.computeBoundingBox();
        const mesh = new THREE.Mesh(g, modelMat);
        mesh.userData.id = o.id;
        objGroup.add(mesh);
        e = { id: o.id, mesh, rev: o.rev };
      }
      e.x = o.x; e.y = o.y; e.bad = !!o.bad;
      next.push(e);
    }
    for (const e of keep.values()) { objGroup.remove(e.mesh); e.mesh.geometry.dispose(); }
    objects = next;
    if (selected != null && !objects.some((o) => o.id === selected)) selected = null;
    placeObjects();
    if (opt && opt.fit) fitObjects();
    render();
  }
  function placeObjects() {
    const cx = bed.ox + bed.w / 2, cy = bed.oy + bed.d / 2;
    for (const o of objects) {
      o.mesh.position.set(cx + o.x, cy + o.y, 0);
      o.mesh.material = o.id === selected ? selMat : o.bad ? badMat : modelMat;
    }
    objGroup.visible = !paths || !pathsVisible;
  }
  function fitObjects() {
    if (!objects.length) { fitBed(); return; }
    const bb = new THREE.Box3();
    for (const o of objects) { o.mesh.updateMatrixWorld(); bb.expandByObject(o.mesh); }
    bb.min.z = 0;
    bb.expandByScalar(Math.max(5, bb.getSize(new THREE.Vector3()).length() * 0.15));
    fit(bb);
  }
  function setSelected(id) { selected = id; placeObjects(); render(); }
  // Druckbahnen ein/aus (aus = Objekte zeigen, z. B. nach Antippen eines Objekts)
  function setPathsVisible(on) {
    pathsVisible = !!on;
    if (paths) { paths.below.visible = pathsVisible; paths.current.visible = pathsVisible; nozzle.visible = pathsVisible && paths.end > 0; }
    placeObjects();
    render();
  }
  // Antippen (kurz, ohne Bewegung, ein Finger) → Rückruf mit Objekt-id oder null
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
    tapCb(pickObject({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }));
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  const raycaster = new THREE.Raycaster();
  function pickObject(ndc) {
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const was = objGroup.visible;
    objGroup.visible = true; // auch unter den Druckbahnen treffbar
    const hit = raycaster.intersectObjects(objects.map((o) => o.mesh), false)[0];
    objGroup.visible = was;
    return hit ? hit.object.userData.id : null;
  }
  // Bildschirmpunkt (CSS-Pixel relativ zur Ansicht) eines Objekts – für Tests
  function screenPos(id) {
    const o = objects.find((x) => x.id === id);
    if (!o) return null;
    o.mesh.geometry.computeBoundingBox();
    const c = o.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).add(o.mesh.position);
    c.project(camera);
    return { x: ((c.x + 1) / 2) * (container.clientWidth || 1), y: ((1 - c.y) / 2) * (container.clientHeight || 1) };
  }
  // tp: { pos: Float32Array (6 je Bahnstück), col: Float32Array (6 je Bahnstück), count }
  function showToolpaths(tp) {
    clearToolpaths();
    if (!tp) return;
    // zwei Geometrien teilen sich dieselben Puffer, jede mit eigenem Zeichenbereich
    const posAttr = new THREE.BufferAttribute(tp.pos, 3), colAttr = new THREE.BufferAttribute(tp.col, 3);
    const gBelow = new THREE.BufferGeometry(), gCur = new THREE.BufferGeometry();
    for (const g of [gBelow, gCur]) { g.setAttribute('position', posAttr); g.setAttribute('color', colAttr); }
    const below = new THREE.LineSegments(gBelow, new THREE.LineBasicMaterial({ vertexColors: true, color: theme.dim }));
    const current = new THREE.LineSegments(gCur, new THREE.LineBasicMaterial({ vertexColors: true }));
    below.frustumCulled = false; current.frustumCulled = false;
    scene.add(below); scene.add(current);
    paths = { below, current, pos: tp.pos, count: tp.count, end: 0 };
    pathsVisible = true;
    placeObjects();
    setProgress(0, tp.count);
  }
  function clearToolpaths() {
    if (paths) {
      scene.remove(paths.below); scene.remove(paths.current);
      paths.below.geometry.dispose(); paths.current.geometry.dispose();
      paths = null;
    }
    nozzle.visible = false;
    pathsVisible = true;
    placeObjects();
    render();
  }
  // Bahnstücke [0, layerStart) gedimmt, [layerStart, end) hell; Düse am Ende
  function setProgress(layerStart, end) {
    if (!paths) return;
    paths.below.geometry.setDrawRange(0, 2 * layerStart);
    paths.current.geometry.setDrawRange(2 * layerStart, 2 * Math.max(0, end - layerStart));
    paths.end = end;
    if (end > 0) {
      const i = (end - 1) * 6 + 3;
      nozzle.position.set(paths.pos[i], paths.pos[i + 1], paths.pos[i + 2]);
      nozzle.visible = pathsVisible;
    } else nozzle.visible = false;
    render();
  }

  new ResizeObserver(resize).observe(container);
  buildBed();
  fitBed();
  resize();
  return { setBed, setTheme, setObjects, setSelected, setPathsVisible, pathsVisible: () => pathsVisible, onTap: (cb) => { tapCb = cb; }, pickObject, screenPos, fitObjects,
    showToolpaths, clearToolpaths, setProgress, render, resize, _scene: scene };
}

window.SlicerViewer = { createViewer };
