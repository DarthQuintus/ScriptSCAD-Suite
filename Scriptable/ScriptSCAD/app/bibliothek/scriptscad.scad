// ScriptSCAD-Bibliothek 1 – Gewinde, Muttern, Fasen, Abrundungen (ohne fremde Bibliotheken, offline)
// Nutzung am Dateianfang:  use <scriptscad.scad>
// In ScriptSCAD Studio immer verfügbar. Am Mac/PC: diese Datei neben die .scad-Datei legen
// (iCloud Drive/Scriptable/ScriptSCAD/app/bibliothek/scriptscad.scad).
// Lizenz: frei verwendbar (CC0). Alle Maße in mm.
//
// Kurzübersicht
//   gewinde(d, h, p)            Außengewinde (Bolzen) ab z = 0 nach oben, ISO-metrisch, Spitze unten angefast
//   gewinde_innen(d, h, p)      Negativ für Innengewinde – in difference() abziehen
//   mutter(d, h, sw, p)         Sechskantmutter mit Innengewinde
//   schraube(d, l, p)           Sechskantschraube (Kopf unten, Schaft nach oben)
//   regelsteigung(d)            Steigung des Regelgewindes (z. B. 1,5 für M10)
//   kernloch(d, p)              Bohrdurchmesser für ein Innengewinde (z. B. 8,5 für M10)
//   schluesselweite(d)          Schlüsselweite der Sechskantmutter (z. B. 16 für M10)
//   fase_wuerfel(groesse, fase, center)        Quader mit gefasten Kanten
//   rund_wuerfel(groesse, r, center, nur_seiten) Quader mit gerundeten Kanten (nur_seiten: nur senkrechte Kanten)
//   fase_zylinder(d, h, fase, oben, unten, center)  Zylinder mit Fase oben/unten
//   rund_zylinder(d, h, r, oben, unten, center)     Zylinder mit gerundeter Kante oben/unten
//   fase_loch(d, h, fase, center)              Bohrung (Negativ) mit Senkung oben und unten

// ---------- Tabellen (ISO 261 / ISO 4032) ----------
_regel = [[1, .25], [1.2, .25], [1.6, .35], [2, .4], [2.5, .45], [3, .5], [3.5, .6], [4, .7], [5, .8], [6, 1], [7, 1], [8, 1.25],
          [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5], [20, 2.5], [22, 2.5], [24, 3], [27, 3], [30, 3.5], [33, 3.5],
          [36, 4], [39, 4], [42, 4.5], [45, 4.5], [48, 5], [52, 5], [56, 5.5], [60, 5.5], [64, 6]];
_sw = [[2, 4], [2.5, 5], [3, 5.5], [4, 7], [5, 8], [6, 10], [8, 13], [10, 16], [12, 18], [14, 21], [16, 24], [18, 27],
       [20, 30], [22, 34], [24, 36], [27, 41], [30, 46], [33, 50], [36, 55], [42, 65], [48, 75], [56, 85], [64, 95]];
// Wert zum nächstgelegenen Durchmesser in der Tabelle
function _nachschlagen(t, d) = let(i = [for (k = [0 : len(t) - 1]) abs(t[k][0] - d)], m = min(i)) t[search(m, i)[0]][1];

function regelsteigung(d) = _nachschlagen(_regel, d);
function kernloch(d, p = 0) = d - (p > 0 ? p : regelsteigung(d));
function schluesselweite(d) = d >= 2 && d <= 64 ? _nachschlagen(_sw, d) : 1.5 * d;
function _seg(d) = $fn > 0 ? max(24, $fn) : max(36, min(120, round(d * 3.2)));

// ---------- Gewinde ----------
// Schraubenkörper: ISO-Profil (60°, Spitze p/8, Grund p/4) läuft als polyhedron um einen Kernzylinder, von z = 0 bis h.
module _gewinde_koerper(d, p, h, seg) {
  tiefe = 0.5413 * p;                       // Gewindetiefe 5/8 · H
  ri = d / 2 - tiefe;                       // Kernradius
  ein = min(0.3, 0.1 * p);                  // Profil greift etwas in den Kern → saubere Verbindung
  rb = ri - ein;
  zb = 0.375 * p + ein * 0.3125 * p / tiefe;  // halbe Profilbreite am Fuß
  zk = p / 16;                              // halbe Breite der Spitze
  prof = [[rb, -zb], [d / 2, -zk], [d / 2, zk], [rb, zb]];
  n = ceil((h + 2 * p) / p * seg);
  pts = [for (k = [0 : n]) let(a = 360 * k / seg, z = -p + p * k / seg) for (q = prof) [q[0] * cos(a), q[0] * sin(a), z + q[1]]];
  faces = concat([[3, 2, 1, 0], [for (j = [0 : 3]) n * 4 + j]],
                 [for (k = [0 : n - 1], j = [0 : 3]) [k * 4 + j, k * 4 + (j + 1) % 4, (k + 1) * 4 + (j + 1) % 4, (k + 1) * 4 + j]]);
  intersection() {
    union() {
      translate([0, 0, -1]) cylinder(r = ri, h = h + 2, $fn = seg);
      polyhedron(points = pts, faces = faces, convexity = 6);
    }
    cylinder(r = d, h = h, $fn = 8);
  }
}

// Außengewinde (Bolzen). d = Nenndurchmesser (M-Zahl), h = Länge, p = Steigung (0 = Regelgewinde),
// links = Linksgewinde, fase_unten/fase_oben = 45°-Anfasung am Gewindeende.
module gewinde(d, h, p = 0, links = false, fase_unten = true, fase_oben = false) {
  st = p > 0 ? p : regelsteigung(d);
  seg = _seg(d);
  ri = d / 2 - 0.5413 * st;
  mirror([links ? 1 : 0, 0, 0]) intersection() {
    _gewinde_koerper(d, st, h, seg);
    // 45°-Kegel an den Enden (schneiden nur die Gewindespitzen ab; ohne Fase reicht der Kegel weit nach außen)
    cylinder(h = h, r1 = fase_unten ? ri : d, r2 = fase_unten ? ri + h : d + h, $fn = seg);
    cylinder(h = h, r1 = fase_oben ? ri + h : d + h, r2 = fase_oben ? ri : d, $fn = seg);
  }
}

// Innengewinde als Negativ (in difference() abziehen). spiel = radiales Spiel für den 3D-Druck,
// senkung = 45°-Ansenkung an beiden Enden. Reicht 0,01 mm über die Enden hinaus.
module gewinde_innen(d, h, p = 0, spiel = 0.15, links = false, senkung = true) {
  st = p > 0 ? p : regelsteigung(d);
  seg = _seg(d);
  D = d + 2 * spiel;
  mirror([links ? 1 : 0, 0, 0]) translate([0, 0, -0.01]) union() {
    _gewinde_koerper(D, st, h + 0.02, seg);
    cylinder(d = kernloch(d, st) + 2 * spiel, h = h + 0.02, $fn = seg);
    if (senkung) {
      cylinder(h = st / 2 + 0.01, d1 = D + 0.5, d2 = D - st, $fn = seg);
      translate([0, 0, h + 0.02 - st / 2 - 0.01]) cylinder(h = st / 2 + 0.01, d1 = D - st, d2 = D + 0.5, $fn = seg);
    }
  }
}

// Sechskantmutter. h = Höhe (0 = 0,8 · d), sw = Schlüsselweite (0 = ISO 4032), Kanten 30° angefast.
module mutter(d, h = 0, sw = 0, p = 0, spiel = 0.15, links = false) {
  hh = h > 0 ? h : 0.8 * d;
  s = sw > 0 ? sw : schluesselweite(d);
  e = s / cos(30);                          // Eckmaß
  difference() {
    intersection() {
      cylinder(d = e, h = hh, $fn = 6);
      // Fase der Ecken oben und unten
      union() {
        cylinder(h = hh / 2, d1 = s * 0.95, d2 = s * 0.95 + hh * 1.15, $fn = _seg(s));
        translate([0, 0, hh / 2]) cylinder(h = hh / 2, d1 = s * 0.95 + hh * 1.15, d2 = s * 0.95, $fn = _seg(s));
      }
    }
    gewinde_innen(d, hh, p, spiel, links);
  }
}

// Sechskantschraube: Kopf (k = 0,7 · d) unten auf z = 0, Gewindeschaft der Länge l nach oben.
// gewinde_laenge = 0 → ganze Länge mit Gewinde.
module schraube(d, l, p = 0, gewinde_laenge = 0, sw = 0, links = false) {
  k = 0.7 * d;
  s = sw > 0 ? sw : schluesselweite(d);
  gl = gewinde_laenge > 0 ? min(gewinde_laenge, l) : l;
  intersection() {
    cylinder(d = s / cos(30), h = k, $fn = 6);
    cylinder(h = k, d1 = s * 0.95 + k * 1.15 * 2, d2 = s * 0.95, $fn = _seg(s));
  }
  translate([0, 0, k - 0.01]) {
    if (gl < l) cylinder(d = d, h = l - gl + 0.02, $fn = _seg(d));
    translate([0, 0, l - gl]) gewinde(d, gl + 0.01, p, links, fase_unten = false, fase_oben = true);
  }
}

// ---------- Fasen und Abrundungen ----------
function _vec3(g) = is_list(g) ? g : [g, g, g];

// Quader mit gefasten Kanten (45°, fase = Schenkellänge)
module fase_wuerfel(groesse, fase = 1, center = false) {
  g = _vec3(groesse);
  f = min(fase, min(g) / 2 - 0.001);
  translate(center ? -g / 2 : [0, 0, 0]) hull() {
    translate([f, f, 0]) cube([g[0] - 2 * f, g[1] - 2 * f, g[2]]);
    translate([f, 0, f]) cube([g[0] - 2 * f, g[1], g[2] - 2 * f]);
    translate([0, f, f]) cube([g[0], g[1] - 2 * f, g[2] - 2 * f]);
  }
}

// Quader mit gerundeten Kanten. nur_seiten = true → nur die senkrechten Kanten gerundet (Ober-/Unterseite flach)
module rund_wuerfel(groesse, r = 2, center = false, nur_seiten = false) {
  g = _vec3(groesse);
  rr = min(r, min(nur_seiten ? [g[0], g[1]] : g) / 2 - 0.001);
  seg = $fn > 0 ? $fn : max(16, min(64, round(rr * 8)));
  translate(center ? -g / 2 : [0, 0, 0]) hull()
    for (x = [rr, g[0] - rr], y = [rr, g[1] - rr])
      if (nur_seiten) translate([x, y, 0]) cylinder(r = rr, h = g[2], $fn = seg);
      else for (z = [rr, g[2] - rr]) translate([x, y, z]) sphere(r = rr, $fn = seg);
}

// Zylinder mit 45°-Fase oben und/oder unten
module fase_zylinder(d, h, fase = 1, oben = true, unten = true, center = false) {
  f = min(fase, d / 2 - 0.001, h / ((oben ? 1 : 0) + (unten ? 1 : 0) + 0.001) - 0.001);
  r = d / 2;
  translate([0, 0, center ? -h / 2 : 0]) rotate_extrude(angle = 360, $fn = _seg(d))
    polygon([[0, 0], [unten ? r - f : r, 0], [r, unten ? f : 0], [r, oben ? h - f : h], [oben ? r - f : r, h], [0, h]]);
}

// Zylinder mit gerundeter Kante oben und/oder unten (Radius r)
module rund_zylinder(d, h, r = 1, oben = true, unten = true, center = false) {
  rr = min(r, d / 2 - 0.001, h / ((oben ? 1 : 0) + (unten ? 1 : 0) + 0.001) - 0.001);
  R = d / 2;
  seg = $fn > 0 ? $fn : max(16, min(48, round(rr * 8)));
  translate([0, 0, center ? -h / 2 : 0]) rotate_extrude(angle = 360, $fn = _seg(d)) hull() {
    square([0.001, h]);
    if (unten) translate([R - rr, rr]) circle(r = rr, $fn = seg); else square([R, 0.001]);
    if (oben) translate([R - rr, h - rr]) circle(r = rr, $fn = seg); else translate([0, h - 0.001]) square([R, 0.001]);
    translate([0, unten ? rr : 0]) square([R - (unten || oben ? rr : 0), h - (unten ? rr : 0) - (oben ? rr : 0)]);
  }
}

// Bohrung als Negativ mit 45°-Senkung an beiden Enden (fase = Senkungstiefe); reicht 0,01 mm über die Enden hinaus
module fase_loch(d, h, fase = 0.5, center = false) {
  translate([0, 0, (center ? -h / 2 : 0) - 0.01]) rotate_extrude(angle = 360, $fn = _seg(d))
    polygon([[0, 0], [d / 2 + fase + 0.01, 0], [d / 2, fase + 0.01], [d / 2, h + 0.01 - fase], [d / 2 + fase + 0.01, h + 0.02], [0, h + 0.02]]);
}
