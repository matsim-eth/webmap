/**
 * Shared "marching ants" line-dasharray animation, used by the Visualize
 * ant-path overlay (useAntPath) and the route-direction overlay
 * (useTransitLines). The dashes march from a line's FIRST coordinate toward
 * its LAST — pass `reverse: true` when the travelled direction runs against
 * the drawn geometry.
 */

// 20 dasharray frames forming one seamless dash cycle (dash 3, gap 3).
export const DASH_SEQUENCE = [
  [0, 0.3, 3, 2.7], [0, 0.6, 3, 2.4], [0, 0.9, 3, 2.1], [0, 1.2, 3, 1.8],
  [0, 1.5, 3, 1.5], [0, 1.8, 3, 1.2], [0, 2.1, 3, 0.9], [0, 2.4, 3, 0.6],
  [0, 2.7, 3, 0.3], [0, 3.0, 3, 0], [0.3, 3, 2.7, 0], [0.6, 3, 2.4, 0],
  [0.9, 3, 2.1, 0], [1.2, 3, 1.8, 0], [1.5, 3, 1.5, 0], [1.8, 3, 1.2, 0],
  [2.1, 3, 0.9, 0], [2.4, 3, 0.6, 0], [2.7, 3, 0.3, 0], [3, 3, 0, 0],
];

/**
 * Animate `layerId`'s line-dasharray until cancelled. Self-terminates if the
 * layer is removed. Returns a cancel function — call it in the effect cleanup
 * before tearing the layer down so a rapid re-run can't leave an orphaned
 * loop repainting a new layer that reuses the same id.
 */
export function startDashAnimation(map, layerId, { reverse = false, frameIntervalMs = 50 } = {}) {
  const seq = reverse ? [...DASH_SEQUENCE].reverse() : DASH_SEQUENCE;
  let idx = 0;
  let last = 0;
  let rafId = 0;

  function animate(ts) {
    if (!map.getLayer(layerId)) return;
    if (ts - last >= frameIntervalMs) {
      idx = (idx + 1) % seq.length;
      map.setPaintProperty(layerId, "line-dasharray", seq[idx]);
      last = ts;
    }
    rafId = requestAnimationFrame(animate);
  }
  rafId = requestAnimationFrame(animate);

  return () => cancelAnimationFrame(rafId);
}
