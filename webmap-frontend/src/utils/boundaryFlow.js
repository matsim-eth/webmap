import { booleanPointInPolygon } from '@turf/turf';

/**
 * Boundary-crossing flow accounting for line features that carry directional
 * volume aggregates (right_sum = eastbound, left_sum = westbound).
 *
 * Arrow convention (from preprocessing): a link's arrow is "→" if its
 * start_lon < end_lon (eastbound), "←" otherwise. So right_sum is total
 * eastbound volume on a segment and left_sum is total westbound — independent
 * of the segment's coords[0]→coords[last] direction.
 *
 * For a segment with one endpoint inside the polygon and one outside, we
 * classify by comparing longitudes: eastbound flow heads toward the inside iff
 * the inside endpoint is east of the outside endpoint.
 *
 * Caveats:
 * - Pure N-S segments (inLng == outLng) are skipped; the preprocessor emits
 *   no arrow for them, so right_sum/left_sum are 0 anyway.
 * - "Transit-through" segments (both endpoints outside, geometry passes through
 *   the polygon) are skipped. Net flow accounting is still correct (their two
 *   boundary crossings cancel), but inflow/outflow totals understate them.
 */

const getEndpoints = (geom) => {
  if (!geom) return null;
  if (geom.type === 'LineString') {
    const c = geom.coordinates;
    if (!c?.length) return null;
    return [c[0], c[c.length - 1]];
  }
  if (geom.type === 'MultiLineString') {
    const lines = geom.coordinates;
    if (!lines?.length) return null;
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (!first?.length || !last?.length) return null;
    return [first[0], last[last.length - 1]];
  }
  return null;
};

export function computeBoundaryFlow({ polygonFeatures, drawnPolygons, featureFilter } = {}) {
  if (!polygonFeatures?.length || !drawnPolygons?.length) return null;

  const isInside = (pt) => drawnPolygons.some(p => {
    try { return booleanPointInPolygon(pt, p); } catch { return false; }
  });

  let inflow = 0;
  let outflow = 0;
  let crossingCount = 0;

  for (const f of polygonFeatures) {
    if (featureFilter && !featureFilter(f)) continue;
    const ep = getEndpoints(f.geometry);
    if (!ep) continue;
    const [start, end] = ep;
    const startInside = isInside(start);
    const endInside = isInside(end);
    if (startInside === endInside) continue;

    const inPt = startInside ? start : end;
    const outPt = startInside ? end : start;
    if (inPt[0] === outPt[0]) continue;

    crossingCount += 1;
    const props = f.properties || {};
    const eastbound = Number(props.right_sum) || 0;
    const westbound = Number(props.left_sum) || 0;
    const inIsEast = inPt[0] > outPt[0];

    if (inIsEast) {
      inflow += eastbound;
      outflow += westbound;
    } else {
      inflow += westbound;
      outflow += eastbound;
    }
  }

  if (!crossingCount) return null;
  return { inflow, outflow, net: inflow - outflow, crossingCount };
}
