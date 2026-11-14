// Beispiel: Kiste mit abgerundeten Ecken (Maße in mm)
// Die Werte oben lassen sich unter „Regler“ einstellen.

breite = 60;   // [20:150]
tiefe  = 40;   // [20:150]
hoehe  = 25;   // [5:80]
wand   = 2;    // [1:0.5:5]
radius = 5;    // [1:15]

$fn = 48;

module abgerundet(b, t, h, r) {
  hull() {
    for (x = [r, b - r], y = [r, t - r])
      translate([x, y, 0]) cylinder(h = h, r = r);
  }
}

difference() {
  abgerundet(breite, tiefe, hoehe, radius);
  translate([wand, wand, wand])
    abgerundet(breite - 2 * wand, tiefe - 2 * wand, hoehe, max(radius - wand, 0.5));
}
