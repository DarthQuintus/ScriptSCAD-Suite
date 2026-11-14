// ScriptSCAD Slicer – Einstellungen aus einer G-Code-Datei lesen (Schritt 9g). Global "SlicerImport", ohne Oberfläche (auch in Node-Tests).
// Erkannt werden die Einstellungs-Blöcke von
//   - OrcaSlicer / Bambu Studio / AnycubicSlicerNext:  „; CONFIG_BLOCK_START“ … „; key = value“ … „; CONFIG_BLOCK_END“
//   - PrusaSlicer / SuperSlicer:                       „; prusaslicer_config = begin“ … „; key = value“ … „; prusaslicer_config = end“
//   - Cura:                                            „;SETTING_3 …“ (nur geänderte Werte) + Kopfzeilen
//   - Simplify3D:                                      „;   key,value“ im Kopf
// Sonst: nur Temperaturen aus den ersten M104/M109/M140/M190.
// Ergebnis: { slicer, printer: { name, flavor, startGcode, endGcode, bedX, bedY, bedZ, nozzle, filamentDiameter, centerZero, round }, material, values, found: [Schlüssel] }
// Werte in den Namen des Slicers (slicer-settings.js); nur was sicher gelesen wurde ist enthalten.
(function (root) {
  'use strict';
  const first = (v) => String(v == null ? '' : v).split(/[;,]/)[0].trim().replace(/^"|"$/g, '');
  const num = (v) => { const n = parseFloat(first(v)); return isFinite(n) ? n : null; };
  const bool = (v) => /^(1|true|yes)$/i.test(first(v));
  const unesc = (v) => String(v == null ? '' : v).replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s+$/, '');
  const PATTERNS = { grid: 'grid', line: 'lines', lines: 'lines', rectilinear: 'lines', alignedrectilinear: 'lines', 'monotonic': 'lines', triangles: 'triangles', 'tri-hexagon': 'triangles', stars: 'triangles',
    cubic: 'cubic', adaptivecubic: 'cubic', supportcubic: 'cubic', cubicsubdiv: 'cubic', gyroid: 'gyroid', zigzag: 'zigzag', 'zig-zag': 'zigzag', concentric: 'concentric', honeycomb: 'triangles', '3dhoneycomb': 'cubic' };
  const flavorOf = (f) => (/reprapfirmware|reprap \(reprap\)|^reprap$|rrf/i.test(f) ? 'RepRap (RepRap)' : /repetier/i.test(f) ? 'Repetier' : 'RepRap (Marlin/Sprinter)');
  const MATERIALS = ['PLA', 'PETG', 'ABS', 'TPU'];
  function materialOf(t) {
    const s = first(t).toUpperCase();
    if (/PETG|PCTG|PET/.test(s)) return 'PETG';
    if (/ABS|ASA/.test(s)) return 'ABS';
    if (/TPU|TPE|FLEX/.test(s)) return 'TPU';
    if (/PLA/.test(s)) return 'PLA';
    return null;
  }
  // „0x0,220x0,220x220,0x220“ → Bettgröße + Ursprung in der Mitte?
  function bedShape(v) {
    const pts = String(v).split(',').map((p) => p.trim().split('x').map(parseFloat)).filter((p) => p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 3) return null;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { bedX: +(x1 - x0).toFixed(1), bedY: +(y1 - y0).toFixed(1), centerZero: x0 < -1 && y0 < -1, round: pts.length > 8 };
  }
  function put(o, k, v) { if (v !== null && v !== undefined && !(typeof v === 'number' && !isFinite(v))) o[k] = v; }

  // „; key = value“-Zeilen zwischen zwei Marken → Tabelle
  function keyValues(text, startRe, endRe) {
    const s = text.search(startRe);
    if (s < 0) return null;
    const rest = text.slice(s);
    const e = rest.search(endRe);
    const block = e > 0 ? rest.slice(0, e) : rest;
    const kv = {};
    for (const line of block.split('\n')) {
      const m = /^;\s*([A-Za-z0-9_]+)\s*=\s?(.*)$/.exec(line.replace(/\r$/, ''));
      if (m) kv[m[1]] = m[2];
    }
    return Object.keys(kv).length ? kv : null;
  }

  function fromOrca(kv, r) {
    const v = r.values, p = r.printer;
    put(v, 'nozzleTemp', num(kv.nozzle_temperature)); put(v, 'nozzleTemp0', num(kv.nozzle_temperature_initial_layer));
    const bedKey = ['hot_plate_temp', 'textured_plate_temp', 'eng_plate_temp', 'cool_plate_temp', 'bed_temperature'].find((k) => num(kv[k]) > 0);
    if (bedKey) { put(v, 'bedTemp', num(kv[bedKey])); put(v, 'bedTemp0', num(kv[bedKey + '_initial_layer']) != null ? num(kv[bedKey + '_initial_layer']) : num(kv[bedKey])); }
    put(v, 'fanMax', num(kv.fan_max_speed)); put(v, 'fanMin', num(kv.fan_min_speed));
    put(v, 'layerHeight', num(kv.layer_height)); put(v, 'layerHeight0', num(kv.initial_layer_print_height));
    if (!/%/.test(first(kv.line_width)) && num(kv.line_width) > 0) put(v, 'lineWidth', num(kv.line_width));
    put(v, 'walls', num(kv.wall_loops)); put(v, 'topLayers', num(kv.top_shell_layers)); put(v, 'bottomLayers', num(kv.bottom_shell_layers));
    put(v, 'infill', num(kv.sparse_infill_density)); put(v, 'infillPattern', PATTERNS[first(kv.sparse_infill_pattern).toLowerCase()]);
    put(v, 'speedPrint', num(kv.inner_wall_speed)); put(v, 'speedOuterWall', num(kv.outer_wall_speed)); put(v, 'speedInfill', num(kv.sparse_infill_speed));
    put(v, 'speedFirstLayer', num(kv.initial_layer_speed)); put(v, 'travelSpeed', num(kv.travel_speed));
    put(v, 'retract', num(kv.retraction_length)); put(v, 'retractSpeed', num(kv.retraction_speed)); put(v, 'zHop', num(kv.z_hop));
    if (kv.enable_support != null) v.support = bool(kv.enable_support);
    put(v, 'supportAngle', num(kv.support_threshold_angle) > 0 ? num(kv.support_threshold_angle) : null);
    if (kv.support_on_build_plate_only != null) v.supportType = bool(kv.support_on_build_plate_only) ? 'buildplate' : 'everywhere';
    const brim = first(kv.brim_type).toLowerCase();
    if (num(kv.raft_layers) > 0) v.adhesion = 'raft';
    else if (brim && brim !== 'no_brim' && !(brim === 'auto_brim' && !(num(kv.brim_width) > 0))) v.adhesion = 'brim';
    else if (kv.skirt_loops != null) v.adhesion = num(kv.skirt_loops) > 0 ? 'skirt' : 'none';
    put(v, 'brimWidth', num(kv.brim_width) > 0 ? num(kv.brim_width) : null);
    Object.assign(p, bedShape(kv.printable_area) || {});
    put(p, 'bedZ', num(kv.printable_height)); put(p, 'nozzle', num(kv.nozzle_diameter)); put(p, 'filamentDiameter', num(kv.filament_diameter));
    if (kv.machine_start_gcode != null) p.startGcode = unesc(kv.machine_start_gcode);
    if (kv.machine_end_gcode != null) p.endGcode = unesc(kv.machine_end_gcode);
    put(p, 'name', first(kv.printer_model) || first(kv.printer_settings_id) || null);
    if (kv.gcode_flavor != null) p.flavor = flavorOf(first(kv.gcode_flavor));
    r.material = materialOf(kv.filament_type);
  }
  function fromPrusa(kv, r) {
    const v = r.values, p = r.printer;
    put(v, 'nozzleTemp', num(kv.temperature)); put(v, 'nozzleTemp0', num(kv.first_layer_temperature));
    put(v, 'bedTemp', num(kv.bed_temperature)); put(v, 'bedTemp0', num(kv.first_layer_bed_temperature));
    put(v, 'fanMax', num(kv.max_fan_speed)); put(v, 'fanMin', num(kv.min_fan_speed));
    put(v, 'layerHeight', num(kv.layer_height));
    if (!/%/.test(first(kv.first_layer_height))) put(v, 'layerHeight0', num(kv.first_layer_height));
    if (!/%/.test(first(kv.extrusion_width)) && num(kv.extrusion_width) > 0) put(v, 'lineWidth', num(kv.extrusion_width));
    put(v, 'walls', num(kv.perimeters)); put(v, 'topLayers', num(kv.top_solid_layers)); put(v, 'bottomLayers', num(kv.bottom_solid_layers));
    put(v, 'infill', num(kv.fill_density)); put(v, 'infillPattern', PATTERNS[first(kv.fill_pattern).toLowerCase()]);
    put(v, 'speedPrint', num(kv.perimeter_speed));
    if (!/%/.test(first(kv.external_perimeter_speed))) put(v, 'speedOuterWall', num(kv.external_perimeter_speed));
    put(v, 'speedInfill', num(kv.infill_speed));
    if (!/%/.test(first(kv.first_layer_speed))) put(v, 'speedFirstLayer', num(kv.first_layer_speed));
    put(v, 'travelSpeed', num(kv.travel_speed));
    put(v, 'retract', num(kv.retract_length)); put(v, 'retractSpeed', num(kv.retract_speed)); put(v, 'zHop', num(kv.retract_lift));
    if (kv.support_material != null) v.support = bool(kv.support_material);
    put(v, 'supportAngle', num(kv.support_material_threshold) > 0 ? num(kv.support_material_threshold) : null);
    if (kv.support_material_buildplate_only != null) v.supportType = bool(kv.support_material_buildplate_only) ? 'buildplate' : 'everywhere';
    if (num(kv.raft_layers) > 0) v.adhesion = 'raft';
    else if (num(kv.brim_width) > 0) { v.adhesion = 'brim'; v.brimWidth = num(kv.brim_width); }
    else if (kv.skirts != null) v.adhesion = num(kv.skirts) > 0 ? 'skirt' : 'none';
    Object.assign(p, bedShape(kv.bed_shape) || {});
    put(p, 'bedZ', num(kv.max_print_height)); put(p, 'nozzle', num(kv.nozzle_diameter)); put(p, 'filamentDiameter', num(kv.filament_diameter));
    if (kv.start_gcode != null) p.startGcode = unesc(kv.start_gcode);
    if (kv.end_gcode != null) p.endGcode = unesc(kv.end_gcode);
    put(p, 'name', first(kv.printer_model) || first(kv.printer_settings_id) || null);
    if (kv.gcode_flavor != null) p.flavor = flavorOf(first(kv.gcode_flavor));
    r.material = materialOf(kv.filament_type);
  }
  // Cura: „;SETTING_3 “-Zeilen ergeben zusammengesetzt JSON { global_quality: "[values]\nkey = v…", extruder_quality: ["…"] }
  function curaValues(text) {
    const parts = [];
    const re = /^;SETTING_3 (.*)$/gm;
    let m;
    while ((m = re.exec(text))) parts.push(m[1].replace(/\r$/, ''));
    if (!parts.length) return null;
    const kv = {};
    try {
      const j = JSON.parse(parts.join(''));
      for (const ini of [j.global_quality].concat(j.extruder_quality || [])) {
        for (const line of String(ini || '').split(/\\n|\n/)) { const q = /^\s*([a-z0-9_]+)\s*=\s*(.*)$/.exec(line); if (q) kv[q[1]] = q[2]; }
      }
    } catch (e) { return {}; }
    return kv;
  }
  function fromCura(kv, text, r) {
    const v = r.values, p = r.printer;
    put(v, 'layerHeight', num(kv.layer_height)); put(v, 'layerHeight0', num(kv.layer_height_0)); put(v, 'lineWidth', num(kv.line_width));
    put(v, 'walls', num(kv.wall_line_count)); put(v, 'topLayers', num(kv.top_layers)); put(v, 'bottomLayers', num(kv.bottom_layers));
    put(v, 'infill', num(kv.infill_sparse_density)); put(v, 'infillPattern', PATTERNS[first(kv.infill_pattern).toLowerCase()]);
    put(v, 'speedPrint', num(kv.speed_print)); put(v, 'speedOuterWall', num(kv.speed_wall_0)); put(v, 'speedInfill', num(kv.speed_infill));
    put(v, 'speedFirstLayer', num(kv.speed_layer_0)); put(v, 'travelSpeed', num(kv.speed_travel));
    put(v, 'retract', num(kv.retraction_amount)); put(v, 'retractSpeed', num(kv.retraction_speed));
    if (kv.retraction_hop_enabled != null) v.zHop = bool(kv.retraction_hop_enabled) ? (num(kv.retraction_hop) || 0.2) : 0;
    if (kv.support_enable != null) v.support = bool(kv.support_enable);
    put(v, 'supportAngle', num(kv.support_angle));
    if (kv.support_type != null) v.supportType = first(kv.support_type) === 'everywhere' ? 'everywhere' : 'buildplate';
    if (['none', 'skirt', 'brim', 'raft'].includes(first(kv.adhesion_type))) v.adhesion = first(kv.adhesion_type);
    put(v, 'brimWidth', num(kv.brim_width));
    put(v, 'nozzleTemp', num(kv.material_print_temperature)); put(v, 'nozzleTemp0', num(kv.material_print_temperature_layer_0));
    put(v, 'bedTemp', num(kv.material_bed_temperature)); put(v, 'bedTemp0', num(kv.material_bed_temperature_layer_0));
    put(v, 'fanMax', num(kv.cool_fan_speed));
    const head = text.slice(0, 4000);
    const lh = /^;Layer height:\s*([\d.]+)/m.exec(head);
    if (lh && v.layerHeight == null) v.layerHeight = parseFloat(lh[1]);
    const fl = /^;FLAVOR:(.*)$/m.exec(head);
    if (fl) p.flavor = flavorOf(fl[1]);
    const mn = /^;TARGET_MACHINE\.NAME:(.*)$/m.exec(head) || /^;MACHINE\.NAME:(.*)$/m.exec(head);
    if (mn) p.name = mn[1].trim();
  }
  function fromS3D(text, r) {
    const kv = {};
    for (const line of text.slice(0, 60000).split('\n')) { const m = /^;\s{2,}([A-Za-z0-9]+),(.*)$/.exec(line.replace(/\r$/, '')); if (m && !(m[1] in kv)) kv[m[1]] = m[2]; }
    if (!('layerHeight' in kv)) return false;
    const v = r.values, p = r.printer;
    const perMin = (x) => (num(x) != null ? num(x) / 60 : null);
    put(v, 'layerHeight', num(kv.layerHeight));
    if (num(kv.firstLayerHeightPercentage) > 0 && v.layerHeight) v.layerHeight0 = +(v.layerHeight * num(kv.firstLayerHeightPercentage) / 100).toFixed(2);
    put(v, 'lineWidth', num(kv.extruderWidth)); put(v, 'walls', num(kv.perimeterOutlines)); put(v, 'topLayers', num(kv.topSolidLayers)); put(v, 'bottomLayers', num(kv.bottomSolidLayers));
    put(v, 'infill', num(kv.infillPercentage));
    const sp = perMin(kv.defaultSpeed);
    put(v, 'speedPrint', sp);
    if (sp && num(kv.outlineUnderspeed) > 0) v.speedOuterWall = sp * num(kv.outlineUnderspeed);
    if (sp && num(kv.firstLayerUnderspeed) > 0) v.speedFirstLayer = sp * num(kv.firstLayerUnderspeed);
    put(v, 'speedInfill', sp); put(v, 'travelSpeed', perMin(kv.rapidXYspeed));
    put(v, 'retract', num(kv.extruderRetractionDistance)); put(v, 'retractSpeed', perMin(kv.extruderRetractionSpeed)); put(v, 'zHop', num(kv.extruderRetractionZLift));
    if (kv.generateSupport != null) v.support = bool(kv.generateSupport);
    put(v, 'supportAngle', num(kv.maxOverhangAngle));
    if (kv.useSkirt != null || kv.useRaft != null) v.adhesion = bool(kv.useRaft) ? 'raft' : bool(kv.useSkirt) ? (num(kv.skirtOffset) === 0 ? 'brim' : 'skirt') : 'none';
    // Temperaturen: Namen und Sollwerte stehen in getrennten Listen
    const names = String(kv.temperatureName || '').split(','), temps = String(kv.temperatureSetpointTemperatures || '').split(','), isBed = String(kv.temperatureHeatedBed || '').split(',');
    names.forEach((n, i) => {
      const t = parseFloat(temps[i]);
      if (!isFinite(t)) return;
      if (isBed[i] === '1' || /bed/i.test(n)) { v.bedTemp = t; v.bedTemp0 = t; } else if (v.nozzleTemp == null) { v.nozzleTemp = t; v.nozzleTemp0 = t; }
    });
    put(p, 'bedX', num(kv.strokeXoverride)); put(p, 'bedY', num(kv.strokeYoverride)); put(p, 'bedZ', num(kv.strokeZoverride));
    put(p, 'nozzle', num(kv.extruderDiameter)); put(p, 'filamentDiameter', num(kv.filamentDiameters));
    put(p, 'name', first(kv.printerModelsOverride) || first(kv.profileName) || null);
    return true;
  }
  // Notlösung: Temperaturen aus den ersten Heiz-Befehlen
  function temps(text, r) {
    const head = text.slice(0, 20000);
    const n = /^M10[49]\s+(?:T\d+\s+)?S(\d+(?:\.\d+)?)/m.exec(head), b = /^M1(?:40|90)\s+S(\d+(?:\.\d+)?)/m.exec(head);
    if (n && +n[1] > 0 && r.values.nozzleTemp == null) { r.values.nozzleTemp = +n[1]; r.values.nozzleTemp0 = +n[1]; }
    if (b && +b[1] > 0 && r.values.bedTemp == null) { r.values.bedTemp = +b[1]; r.values.bedTemp0 = +b[1]; }
  }

  // text = G-Code (ganz oder Anfang + Ende). settings = SlicerSettings (prüft Bereiche); ohne → ungeprüft.
  function parse(text, settings) {
    text = String(text || '');
    const r = { slicer: null, printer: {}, material: null, values: {}, found: [] };
    let kv;
    if ((kv = keyValues(text, /^; CONFIG_BLOCK_START/m, /^; CONFIG_BLOCK_END/m))) {
      const gen = /^; (?:generated by )?(AnycubicSlicerNext|OrcaSlicer|BambuStudio|Bambu Studio|[A-Za-z]+Slicer[A-Za-z]*)[ ]?([\d.]+)?/mi.exec(text.slice(0, 3000)) || /^; (AnycubicSlicerNext|OrcaSlicer|BambuStudio)/m.exec(text);
      r.slicer = gen ? (gen[1] + (gen[2] ? ' ' + gen[2] : '')) : 'OrcaSlicer/Bambu Studio';
      fromOrca(kv, r);
    } else if ((kv = keyValues(text, /^; (?:prusaslicer|superslicer|slic3r)_config = begin/m, /^; (?:prusaslicer|superslicer|slic3r)_config = end/m))) {
      r.slicer = /superslicer_config/.test(text) ? 'SuperSlicer' : 'PrusaSlicer';
      fromPrusa(kv, r);
    } else if ((kv = curaValues(text)) || /^;Generated with Cura_SteamEngine/m.test(text.slice(0, 4000))) {
      r.slicer = 'Cura';
      fromCura(kv || {}, text, r);
    } else if (/Simplify3D/i.test(text.slice(0, 2000)) && fromS3D(text, r)) {
      r.slicer = 'Simplify3D';
    }
    temps(text, r);
    // Prüfen: nur Werte im erlaubten Bereich übernehmen (auf die Schrittweite gerundet)
    if (settings) {
      const items = {};
      for (const it of settings.all()) items[it.key] = it;
      for (const k of Object.keys(r.values)) {
        const it = items[k];
        const c = it ? settings.clean(it, it.type === 'num' && it.step >= 1 ? Math.round(r.values[k]) : r.values[k]) : null;
        if (c === null) delete r.values[k]; else r.values[k] = c;
      }
      for (const k of ['bedX', 'bedY', 'bedZ']) if (r.printer[k] != null) { const c = settings.clean(items[k], Math.round(r.printer[k])); if (c === null) delete r.printer[k]; else r.printer[k] = c; }
      for (const k of ['nozzle', 'filamentDiameter']) if (r.printer[k] != null) { const c = settings.clean(items[k], r.printer[k]); if (c === null) delete r.printer[k]; else r.printer[k] = c; }
    }
    if (r.material && !MATERIALS.includes(r.material)) r.material = null;
    r.found = Object.keys(r.values);
    return r;
  }

  const api = { parse, bedShape, keyValues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SlicerImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
