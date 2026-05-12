import { useEffect } from 'react';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

// Modules that own a Visualize button + the ant-path overlay. The ant-line
// is sourced off either `network-source` (most modules) or
// `transit-volumes-source` (TransitVolumes); any other active module means
// the overlay must be removed.
const ANT_MODULES = new Set(['Volumes', 'Network', 'VolumeFlow', 'LinkSpeeds', 'TransitVolumes']);

export default function useAntPath(mapRef, visualizeLinkId, graphExpandedRef, currentModule, visualizeNonce) {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Always remove a stale ant-line first — if the user switched modules
    // without changing visualizeLinkId, the previous layer would otherwise
    // remain visible in modules that don't own this overlay.
    safeRemoveLayer(map, "ant-line");
    safeRemoveSource(map, "ant-path");

    const moduleNow = currentModule ?? graphExpandedRef?.current;
    if (!visualizeLinkId || !ANT_MODULES.has(moduleNow)) return;

    const sourceId =
      moduleNow === "TransitVolumes" ? "transit-volumes-source" : "network-source";

    const source = map.getSource(sourceId);
    const data = source && source._data;
    if (!data) return;

    // --- Find the feature containing this link ID -----------------------------
    const idStr = String(visualizeLinkId);

    const findFeatureByLinkId = () => {
      for (const f of data.features || []) {
        // Parse pipe-separated per_id_keys and per_id_directions
        const keys = parsePipeList(f?.properties?.per_id_keys);
        const directions = parsePipeList(f?.properties?.per_id_directions);
        
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

    // Zoom to fit the link's bounding box so the user can see what's being
    // animated even when the previous viewport was far away.
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of mergedCoords) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    if (Number.isFinite(minLng) && Number.isFinite(minLat)) {
      // The right sidebar covers part of the map's visible area, so a
      // symmetric padding makes the link center under the sidebar rather
      // than in the actual visible viewport. Read the live widths and
      // pass them as asymmetric padding so the link lands centered in the
      // map area the user can actually see.
      const rightSidebarEl = document.querySelector('.right-sidebar');
      const leftSidebarEl = document.querySelector('.left-sidebar');
      const rightWidth = rightSidebarEl ? rightSidebarEl.getBoundingClientRect().width : 0;
      const leftWidth = leftSidebarEl ? leftSidebarEl.getBoundingClientRect().width : 0;
      try {
        map.fitBounds(
          [[minLng, minLat], [maxLng, maxLat]],
          {
            padding: {
              top: 80,
              bottom: 80,
              left: leftWidth + 60,
              right: rightWidth + 60,
            },
            maxZoom: 16,
            duration: 700,
          }
        );
      } catch {}
    }

    map.addSource("ant-path", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: mergedCoords },
        properties:
          moduleNow === "TransitVolumes"
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
      safeRemoveLayer(map, "ant-line");
      safeRemoveSource(map, "ant-path");
    };
    // re-run when the selected per-id changes OR the active module switches
    // (so the cleanup above tears down the overlay in non-ant modules).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualizeLinkId, currentModule, visualizeNonce]);
}
