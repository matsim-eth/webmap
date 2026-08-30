import { useState, useEffect } from 'react';
import { booleanIntersects } from '@turf/turf';
import { isMajorRoad } from '../components/map/_lib/mapboxFilters';

function applyFading(map, layerIds, labelLayerIds, fadeOpacity) {
  const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 1, fadeOpacity];
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', fade);
  }
  for (const id of labelLayerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'text-opacity', fade);
  }
}

function clearFading(map, sourceId, layerIds, labelLayerIds, extraStateSourceIds = []) {
  if (map.getSource(sourceId)) map.removeFeatureState({ source: sourceId });
  for (const sid of extraStateSourceIds) {
    if (map.getSource(sid)) map.removeFeatureState({ source: sid });
  }
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', 1);
  }
  for (const id of labelLayerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'text-opacity', 1);
  }
}

/**
 * Polygon selection hook for line features (network segments / transit volume links).
 * Listens for MapboxDraw polygon events, spatially filters line features
 * using booleanIntersects, applies feature-state fading on the map,
 * and returns the filtered features array.
 *
 * Requires `generateId: true` on the Mapbox source so that
 * setFeatureState can address features by their array index.
 *
 * `extraStateSourceIds`: sources whose features carry an explicit `id` equal to
 * the parent feature's index in `featureGeoJSON` (e.g. the transit-volumes split
 * source) — the same inPolygon states are mirrored onto them so layers drawn
 * from those sources fade consistently with the main source's layers.
 *
 * `onSelectionIds`: optional callback receiving the selected features' ids
 * (indices into featureGeoJSON.features, = the source's generateId ids), or
 * null when no polygon is active. Lets a module drive a hard map filter
 * (hide instead of fade) off the same spatial selection.
 */
export default function useLinePolygon({
  mapRef,
  drawRef,
  featureGeoJSON,
  isGraphExpanded,
  activeModule,
  sourceId,
  layerIds,
  labelLayerIds = [],
  showMajorRoadsOnly = false,
  onPolygonChange,
  onSelectionIds,
  fadeOpacity = 0.2,
  extraStateSourceIds = [],
}) {
  const [polygonFeatures, setPolygonFeatures] = useState([]);

  // effect:audited — imperative mapbox draw event listeners for spatial filtering + feature-state fading
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || isGraphExpanded !== activeModule) {
      if (map && map.getSource(sourceId)) {
        clearFading(map, sourceId, layerIds, labelLayerIds, extraStateSourceIds);
      }
      setPolygonFeatures([]);
      onSelectionIds?.(null);
      return;
    }

    const computeSelection = () => {
      const draw = drawRef?.current;
      if (!draw || !featureGeoJSON?.features?.length) {
        clearFading(map, sourceId, layerIds, labelLayerIds, extraStateSourceIds);
        setPolygonFeatures([]);
        onSelectionIds?.(null);
        return;
      }

      const polygons = draw.getAll?.()?.features || [];
      if (!polygons.length) {
        clearFading(map, sourceId, layerIds, labelLayerIds, extraStateSourceIds);
        setPolygonFeatures([]);
        onSelectionIds?.(null);
        return;
      }

      // One pass over the full feature list so each selected feature's index
      // (= the source's generateId id) is captured alongside it. Features that
      // fail the major-roads filter (when active) are skipped entirely.
      const filtered = [];
      const ids = [];
      featureGeoJSON.features.forEach((f, i) => {
        if (showMajorRoadsOnly && !isMajorRoad(f.properties)) return;
        if (!f.geometry) return;
        const inside = polygons.some((p) => {
          try { return booleanIntersects(f, p); } catch { return false; }
        });
        if (inside) { filtered.push(f); ids.push(i); }
      });

      setPolygonFeatures(filtered);
      onSelectionIds?.(ids);

      // Remove existing single-feature highlight
      if (map.getLayer('network-highlight')) map.removeLayer('network-highlight');
      if (map.getSource('network-highlight')) map.removeSource('network-highlight');

      // Apply feature-state fading
      if (map.getSource(sourceId) && filtered.length > 0) {
        map.removeFeatureState({ source: sourceId });
        // Mirror onto sources whose feature ids equal the parent feature index
        // (e.g. the transit split source), so their layers fade consistently.
        const extraSources = extraStateSourceIds.filter((sid) => map.getSource(sid));
        for (const sid of extraSources) map.removeFeatureState({ source: sid });

        for (const i of ids) {
          map.setFeatureState({ source: sourceId, id: i }, { inPolygon: true });
          for (const sid of extraSources) {
            map.setFeatureState({ source: sid, id: i }, { inPolygon: true });
          }
        }

        applyFading(map, layerIds, labelLayerIds, fadeOpacity);
      }
    };

    // onPolygonChange should only fire on actual user draw edits, NOT on
    // every effect re-run (e.g. when featureGeoJSON updates due to time/line
    // filter changes). Otherwise it loops back and clears whatever selection
    // the caller is trying to make.
    const handleDrawEvent = () => {
      onPolygonChange?.();
      computeSelection();
    };

    map.on('draw.create', handleDrawEvent);
    map.on('draw.update', handleDrawEvent);
    map.on('draw.delete', handleDrawEvent);
    computeSelection();

    return () => {
      map.off('draw.create', handleDrawEvent);
      map.off('draw.update', handleDrawEvent);
      map.off('draw.delete', handleDrawEvent);
    };
  }, [mapRef, drawRef, featureGeoJSON, isGraphExpanded, showMajorRoadsOnly]);

  return polygonFeatures;
}
