// Example: box with rounded corners (dimensions in mm)
// The values at the top can be adjusted under "Sliders".

width  = 60;   // [20:150]
depth  = 40;   // [20:150]
height = 25;   // [5:80]
wall   = 2;    // [1:0.5:5]
radius = 5;    // [1:15]

$fn = 48;

module rounded(w, d, h, r) {
  hull() {
    for (x = [r, w - r], y = [r, d - r])
      translate([x, y, 0]) cylinder(h = h, r = r);
  }
}

difference() {
  rounded(width, depth, height, radius);
  translate([wall, wall, wall])
    rounded(width - 2 * wall, depth - 2 * wall, height, max(radius - wall, 0.5));
}
