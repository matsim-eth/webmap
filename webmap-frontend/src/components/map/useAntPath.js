import { useEffect } from 'react';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { parsePipeList, arrowForCoords } from './_lib/pipeProps';
import { startDashAnimation } from './_lib/antAnimation';
import { measureMapPadding } from '../sidebar/sidebarLayout';

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
    // Transit link ids may arrive "cleaned" (pt_8503006:0:1_2 → pt_8503006_2,
    // see useTransitVolumesLayer.cleanLinkId) while per_id_keys holds the raw
    // ids — compare both forms.
    const cleanId = (s) => String(s).split("_").map((p) => p.split(":")[0]).join("_");
    const idClean = cleanId(idStr);

    const findFeatureByLinkId = () => {
      for (const f of data.features || []) {
        const keys = parsePipeList(f?.properties?.per_id_keys);
        let index = keys.findIndex(k => String(k) === idStr);
        if (index === -1) index = keys.findIndex(k => cleanId(k) === idClean);
        if (index === -1) continue;
        return { feature: f, index };
      }
      return null;
    };

    const hit = findFeatureByLinkId();
    if (!hit) return;

    const { feature, index } = hit;

    // --- Build a single LineString for the ant path --------------------------
    const mergedCoords =
      feature.geometry?.type === "LineString" ? feature.geometry.coordinates
      : feature.geometry?.type === "MultiLineString" ? feature.geometry.coordinates.flat()
      : [];

    if (!Array.isArray(mergedCoords) || mergedCoords.length < 2) return;

    // --- Travel direction of the selected link vs the drawn geometry ---------
    // The merged geometry runs in ONE of the bundled links' travel directions;
    // a reverse link carries the opposite per_id_arrows glyph. Animate reverse
    // when the selected link's glyph differs from the geometry's own glyph.
    // (Legacy pre-merged assets may instead ship an explicit per_id_directions
    // 'reverse' entry — honour it when present.)
    const props = feature.properties || {};
    const arrows = parsePipeList(props.per_id_arrows);
    const directions = parsePipeList(props.per_id_directions);
    const linkArrow = arrows[index];
    const reverse =
      directions[index] === "reverse" ||
      (!!linkArrow && linkArrow !== arrowForCoords(mergedCoords));

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
      // than in the actual visible viewport. Measure the live widths so the
      // link lands centered in the map area the user can actually see.
      try {
        map.fitBounds(
          [[minLng, minLat], [maxLng, maxLat]],
          {
            padding: { ...measureMapPadding(60), top: 80, bottom: 80 },
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

    // --- Dash animation (reverse when the link runs against the geometry) ----
    const cancelAnts = startDashAnimation(map, "ant-line", { reverse });

    return () => {
      // Stop this run's animation loop before tearing the layer down, so a
      // rapid re-selection can't leave an orphaned loop repainting a new
      // ant-line that happens to reuse the same id.
      cancelAnts();
      safeRemoveLayer(map, "ant-line");
      safeRemoveSource(map, "ant-path");
    };
    // re-run when the selected per-id changes OR the active module switches
    // (so the cleanup above tears down the overlay in non-ant modules).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualizeLinkId, currentModule, visualizeNonce]);
}
