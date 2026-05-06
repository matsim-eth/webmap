// Ray-cast point-in-polygon. Pure JS, no deps.
//
// Used to assign transit stops to user-uploaded custom polygons (the default
// municipality lookup is precomputed offline; custom polygons need on-the-fly
// containment tests).
//
// Coordinates are [lng, lat] in WGS84. The ray-cast is purely geometric and
// ignores spherical effects — fine for the polygon scales we deal with
// (Switzerland-sized regions).

// Test a point against a single linear ring (closed array of [lng, lat]).
const pointInRing = (point, ring) => {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// Polygon = array of rings. First ring is the outer boundary, the rest are
// holes. Point is inside iff inside outer AND not inside any hole.
const pointInPolygon = (point, rings) => {
  if (!rings?.length) return false;
  if (!pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
};

// Find the first feature whose Polygon / MultiPolygon geometry contains the
// point. Returns `null` if none match. Linear scan — fine for the polygon
// counts we expect (a few hundred).
export const findContainingFeature = (point, features) => {
  if (!Array.isArray(point) || point.length < 2 || !features?.length) return null;
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      if (pointInPolygon(point, g.coordinates)) return f;
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        if (pointInPolygon(point, poly)) return f;
      }
    }
  }
  return null;
};
