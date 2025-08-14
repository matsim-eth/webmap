import { useEffect } from 'react';

export default function useAntPath(mapRef, visualizeLinkId, graphExpandedRef) {
  useEffect(() => {
    const map = mapRef.current;
    if (!visualizeLinkId || !map) return;

    const currentModule = graphExpandedRef?.current;
    const sourceId =
      currentModule === "TransitVolumes" ? "transit-volumes-source" : "network-source";

    const source = map.getSource(sourceId);
    const data = source && source._data;
    if (!data) return;

    // --- Find the feature containing this per-id -----------------------------
    const idStr = String(visualizeLinkId);

    const findFeatureByPerId = () => {
      for (const f of data.features || []) {
        let perId = f?.properties?.per_id;
        if (!perId) continue;
        if (typeof perId === 'string') {
          try { perId = JSON.parse(perId); } catch { continue; }
        }
        if (perId && typeof perId === 'object' && idStr in perId) {
          return { feature: f, perIdEntry: perId[idStr] };
        }
      }
      return null;
    };

    const hit = findFeatureByPerId();
    if (!hit) return;

    const { feature, perIdEntry } = hit;
    const direction = perIdEntry?.direction === 'reverse' ? 'reverse' : 'forward';

    // --- Build a single LineString for the ant path --------------------------
    const mergedCoords =
      feature.geometry?.type === "LineString" ? feature.geometry.coordinates
      : feature.geometry?.type === "MultiLineString" ? feature.geometry.coordinates.flat()
      : [];

    if (!Array.isArray(mergedCoords) || mergedCoords.length < 2) return;

    // Clean up old
    if (map.getLayer("ant-line")) map.removeLayer("ant-line");
    if (map.getSource("ant-path")) map.removeSource("ant-path");

    map.addSource("ant-path", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: mergedCoords },
        properties:
          currentModule === "TransitVolumes"
            ? { modes: feature.properties?.modes ?? "" }
            : {},
      },
    });

    map.addLayer({
      id: "ant-line",
      type: "line",
      source: "ant-path",
      layout: {},
      paint: {
        "line-color": "#FF00FF",
        "line-width": 4,
        "line-dasharray": [3, 3], // initial
      },
    });

    // --- Dash animation (reverse when per-id says reverse) -------------------
    const dashArraySeq = [
      [0, 0.3, 3, 2.7], [0, 0.6, 3, 2.4], [0, 0.9, 3, 2.1], [0, 1.2, 3, 1.8],
      [0, 1.5, 3, 1.5], [0, 1.8, 3, 1.2], [0, 2.1, 3, 0.9], [0, 2.4, 3, 0.6],
      [0, 2.7, 3, 0.3], [0, 3.0, 3, 0], [0.3, 3, 2.7, 0], [0.6, 3, 2.4, 0],
      [0.9, 3, 2.1, 0], [1.2, 3, 1.8, 0], [1.5, 3, 1.5, 0], [1.8, 3, 1.2, 0],
      [2.1, 3, 0.9, 0], [2.4, 3, 0.6, 0], [2.7, 3, 0.3, 0], [3, 3, 0, 0],
    ];
    const seq = direction === 'reverse' ? [...dashArraySeq].reverse() : dashArraySeq;

    let idx = 0;
    let last = 0;
    const frameIntervalMs = 50;

    function animate(ts) {
      if (!map.getLayer("ant-line")) return;
      if (ts - last >= frameIntervalMs) {
        idx = (idx + 1) % seq.length;
        map.setPaintProperty("ant-line", "line-dasharray", seq[idx]);
        last = ts;
      }
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);

    return () => {
      if (map.getLayer("ant-line")) map.removeLayer("ant-line");
      if (map.getSource("ant-path")) map.removeSource("ant-path");
    };
  }, [visualizeLinkId]); // re-run when the selected per-id changes
}
