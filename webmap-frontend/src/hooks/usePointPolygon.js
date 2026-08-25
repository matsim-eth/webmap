import { useState, useEffect, useMemo, useRef } from 'react';
import { booleanPointInPolygon } from '@turf/turf';

const STOP_LAYER = 'transit-stops-layer';
const LABEL_LAYER = 'transit-stops-label';
const STOP_SOURCE = 'transit-stops';

function applyPolygonFading(map) {
  const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 1, 0.2];
  if (map.getLayer(STOP_LAYER)) {
    map.setPaintProperty(STOP_LAYER, 'circle-opacity', fade);
    map.setPaintProperty(STOP_LAYER, 'circle-stroke-opacity', fade);
  }
  if (map.getLayer(LABEL_LAYER)) {
    map.setPaintProperty(LABEL_LAYER, 'text-opacity', fade);
  }
}

function clearPolygonFading(map) {
  if (map.getSource(STOP_SOURCE)) {
    map.removeFeatureState({ source: STOP_SOURCE });
  }
  if (map.getLayer(STOP_LAYER)) {
    map.setPaintProperty(STOP_LAYER, 'circle-opacity', 1);
    map.setPaintProperty(STOP_LAYER, 'circle-stroke-opacity', 1);
  }
  if (map.getLayer(LABEL_LAYER)) {
    map.setPaintProperty(LABEL_LAYER, 'text-opacity', 1);
  }
}

/**
 * Listens for MapboxDraw polygon events in Transit mode,
 * spatially filters featureGeoJSON stops, applies mode filter,
 * and returns aggregated selection data for the sidebar.
 * Also manages feature-state fading on the map.
 */
export default function usePointPolygon({
  mapRef,
  drawRef,
  featureGeoJSON,
  isGraphExpanded,
  selectedTransitModes,
  onPolygonChange,
}) {
  const [polygonFeatures, setPolygonFeatures] = useState([]);
  // Tracks whether polygons were present last time computeSelection ran.
  // Used to avoid firing onPolygonChange when the polygon state didn't
  // actually change (e.g. featureGeoJSON refresh on timeRange change),
  // which would otherwise clear the user's selected transit stop.
  const hadPolygonsRef = useRef(false);

  // effect:audited — imperative mapbox draw event listeners for spatial filtering + feature-state fading
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || isGraphExpanded !== 'Transit') {
      if (map) clearPolygonFading(map);
      setPolygonFeatures([]);
      hadPolygonsRef.current = false;
      return;
    }

    const computeSelection = () => {
      const draw = drawRef?.current;
      const notifyIfChanged = (hasPolygonsNow) => {
        if (hadPolygonsRef.current || hasPolygonsNow) onPolygonChange?.();
        hadPolygonsRef.current = hasPolygonsNow;
      };

      if (!draw || !featureGeoJSON?.features?.length) {
        if (hadPolygonsRef.current) clearPolygonFading(map);
        setPolygonFeatures([]);
        notifyIfChanged(false);
        return;
      }

      const polygons = draw.getAll?.()?.features || [];
      if (!polygons.length) {
        if (hadPolygonsRef.current) clearPolygonFading(map);
        setPolygonFeatures([]);
        notifyIfChanged(false);
        return;
      }

      const filtered = featureGeoJSON.features.filter(
        (f) =>
          f.geometry?.type === 'Point' &&
          polygons.some((p) => booleanPointInPolygon(f.geometry, p))
      );
      setPolygonFeatures(filtered);
      notifyIfChanged(true);

      // Remove any single-stop highlight from the map
      if (map.getLayer('transit-highlight-layer')) map.removeLayer('transit-highlight-layer');
      if (map.getSource('transit-highlight')) map.removeSource('transit-highlight');

      // Apply feature-state fading on the map
      if (map.getSource(STOP_SOURCE) && filtered.length > 0) {
        map.removeFeatureState({ source: STOP_SOURCE });
        for (const f of filtered) {
          map.setFeatureState({ source: STOP_SOURCE, id: f.id }, { inPolygon: true });
        }
        applyPolygonFading(map);
      }
    };

    map.on('draw.create', computeSelection);
    map.on('draw.update', computeSelection);
    map.on('draw.delete', computeSelection);

    // Initial computation (e.g. if featureGeoJSON changed while polygons exist)
    computeSelection();

    return () => {
      map.off('draw.create', computeSelection);
      map.off('draw.update', computeSelection);
      map.off('draw.delete', computeSelection);
    };
  }, [mapRef, drawRef, featureGeoJSON, isGraphExpanded]);

  // Aggregate polygon-filtered features, applying the current mode filter
  const polygonSelection = useMemo(() => {
    if (!polygonFeatures.length) return null;

    // Apply mode filter
    let filtered = polygonFeatures;
    if (!selectedTransitModes.includes('all')) {
      filtered = polygonFeatures.filter((f) => {
        let modes = f.properties.modes_list;
        if (typeof modes === 'string') {
          try { modes = JSON.parse(modes); } catch { modes = []; }
        }
        return Array.isArray(modes) && modes.some((m) => selectedTransitModes.includes(m));
      });
    }

    if (!filtered.length) return null;

    const allStopIds = [];
    const allModes = new Set();
    const lineMap = new Map();
    let totalBoardings = 0;
    let totalAlightings = 0;

    for (const f of filtered) {
      const props = f.properties;

      // Stop IDs
      const sid = props.stop_id;
      if (Array.isArray(sid)) {
        allStopIds.push(...sid);
      } else {
        try {
          const parsed = JSON.parse(sid);
          if (Array.isArray(parsed)) allStopIds.push(...parsed);
          else allStopIds.push(...String(sid).split(',').map((s) => s.trim()));
        } catch {
          allStopIds.push(...String(sid).split(',').map((s) => s.trim()));
        }
      }

      // Modes
      let modes = props.modes_list;
      if (typeof modes === 'string') {
        try { modes = JSON.parse(modes); } catch { modes = []; }
      }
      if (Array.isArray(modes)) modes.forEach((m) => allModes.add(m));

      // Lines (deduplicate by line_id + route_id)
      let lines = props.lines;
      if (typeof lines === 'string') {
        try { lines = JSON.parse(lines); } catch { lines = []; }
      }
      if (Array.isArray(lines)) {
        for (const l of lines) {
          const key = `${l.line_id}|${l.route_id}`;
          if (!lineMap.has(key)) lineMap.set(key, l);
        }
      }

      // Volumes
      totalBoardings += props.boardings || 0;
      totalAlightings += props.alightings || 0;
    }

    return {
      name: `${filtered.length} Selected Stops`,
      stop_ids: allStopIds,
      modes_list: [...allModes],
      lines: [...lineMap.values()],
      boardings: totalBoardings,
      alightings: totalAlightings,
      total: totalBoardings + totalAlightings,
    };
  }, [polygonFeatures, selectedTransitModes]);

  return { polygonSelection, polygonFeatures };
}
