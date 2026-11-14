// ScriptSCAD Slicer – Aufbau der Regler (Schritt 9c). Global "SlicerSettings". Texte: slicer-i18n.js (Schlüssel = l_<name>, sec_<abschnitt>).
// Werte-Namen = Felder, die SlicerCore.curaSettings() versteht.
(function (root) {
  'use strict';
  const num = (key, min, max, step, unit) => ({ type: 'num', key, min, max, step, unit });
  const choice = (key, options) => ({ type: 'choice', key, options });
  const toggle = (key) => ({ type: 'toggle', key });
  // Maschine: gehört zum Drucker (wird beim Druckerwechsel überschrieben)
  const MACHINE = [num('bedX', 50, 1000, 1, 'mm'), num('bedY', 50, 1000, 1, 'mm'), num('bedZ', 50, 1000, 1, 'mm'),
    choice('nozzle', [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]), choice('filamentDiameter', [1.75, 2.85]),
    choice('flavor', ['RepRap (Marlin/Sprinter)', 'RepRap (RepRap)', 'Repetier'])]; // G-Code-Dialekt (9g: eigene Drucker)
  const SECTIONS = [
    { id: 'material', items: [num('nozzleTemp', 150, 320, 1, '°C'), num('nozzleTemp0', 150, 320, 1, '°C'), num('bedTemp', 0, 120, 1, '°C'), num('bedTemp0', 0, 120, 1, '°C'),
      num('fanMax', 0, 100, 5, '%'), num('fanMin', 0, 100, 5, '%')] },
    { id: 'quality', items: [num('layerHeight', 0.04, 0.6, 0.02, 'mm'), num('layerHeight0', 0.1, 0.6, 0.02, 'mm'), num('lineWidth', 0.2, 1.2, 0.01, 'mm')] },
    { id: 'shell', items: [num('walls', 1, 10, 1, ''), num('topLayers', 0, 20, 1, ''), num('bottomLayers', 0, 20, 1, '')] },
    { id: 'infill', items: [num('infill', 0, 100, 1, '%'), choice('infillPattern', ['grid', 'lines', 'triangles', 'cubic', 'gyroid', 'zigzag', 'concentric'])] },
    { id: 'speed', items: [num('speedPrint', 10, 500, 5, 'mm/s'), num('speedOuterWall', 5, 500, 5, 'mm/s'), num('speedInfill', 10, 500, 5, 'mm/s'),
      num('speedFirstLayer', 5, 200, 5, 'mm/s'), num('travelSpeed', 30, 600, 10, 'mm/s')] },
    { id: 'retract', items: [num('retract', 0, 10, 0.1, 'mm'), num('retractSpeed', 5, 150, 5, 'mm/s'), num('zHop', 0, 2, 0.1, 'mm')] },
    { id: 'support', items: [toggle('support'), num('supportAngle', 20, 85, 1, '°'), choice('supportType', ['buildplate', 'everywhere'])] },
    { id: 'adhesion', items: [choice('adhesion', ['none', 'skirt', 'brim', 'raft']), num('brimWidth', 1, 20, 1, 'mm')] },
    // 10f: Experte – Naht, Bügeln, Vasen-Modus (Füllmuster steht unter „Füllung“)
    { id: 'expert', items: [choice('seamType', ['shortest', 'back', 'sharpest_corner', 'random']), toggle('ironing'), num('ironingSpacing', 0.05, 1, 0.05, 'mm'),
      num('ironingFlow', 1, 50, 1, '%'), toggle('vase')] },
  ];
  // Wert prüfen: Zahl im Bereich, Auswahl aus der Liste → bereinigter Wert oder null
  function clean(item, v) {
    if (item.type === 'num') {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
      if (!isFinite(n) || n < item.min || n > item.max) return null;
      const d = (String(item.step).split('.')[1] || '').length;
      return +n.toFixed(d);
    }
    if (item.type === 'toggle') return !!v;
    return item.options.some((o) => String(o) === String(v)) ? item.options.find((o) => String(o) === String(v)) : null;
  }
  // Schnelle Plausibilitätswarnungen (keine Sperre)
  function warnings(p) {
    const w = [];
    if (p.layerHeight > p.nozzle * 0.8) w.push('w_layerTooHigh');
    if (p.lineWidth < p.nozzle * 0.8 || p.lineWidth > p.nozzle * 1.6) w.push('w_lineWidth');
    if (p.nozzleTemp0 < 170 || p.nozzleTemp < 170) w.push('w_coldNozzle');
    return w;
  }
  const api = { MACHINE, SECTIONS, clean, warnings, all: () => MACHINE.concat(...SECTIONS.map((s) => s.items)) };
  root.SlicerSettings = api;
})(typeof window !== 'undefined' ? window : globalThis);
