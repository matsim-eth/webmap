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

    // --- Find the feature containing this link ID -----------------------------
    const idStr = String(visualizeLinkId);

    const findFeatureByLinkId = () => {
      for (const f of data.features || []) {
        // Parse pipe-separated per_id_keys and per_id_directions
        const keys = (f?.properties?.per_id_keys || "").split("|").filter(Boolean);
        const directions = (f?.properties?.per_id_directions || "").split("|").filter(Boolean);
        
        // Find the index of the matching link ID
        const index = keys.findIndex(k => String(k) === idStr);
        if (index === -1) continue;
        
        // Get the direction for this link ID at the same index
        const direction = directions[index];
        
        return { 
          feature: f, 
          direction: direction
        };
      }
      return null;
    };

    const hit = findFeatureByLinkId();
    if (!hit) return;

    const { feature, direction } = hit;
    
    // Determine animation direction based on direction field
    const animDirection = direction === 'reverse' ? 'reverse' : 'forward';

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
    const seq = animDirection === 'reverse' ? [...dashArraySeq].reverse() : dashArraySeq;

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
