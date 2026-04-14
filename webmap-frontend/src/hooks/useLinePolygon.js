import { useState, useEffect } from 'react';
import { booleanIntersects } from '@turf/turf';

function applyFading(map, layerIds, labelLayerIds) {
  const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 1, 0.2];
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', fade);
  }
  for (const id of labelLayerIds) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'text-opacity', fade);
  }
}

function clearFading(map, sourceId, layerIds, labelLayerIds) {
  if (map.getSource(sourceId)) map.removeFeatureState({ source: sourceId });
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
}) {
  const [polygonFeatures, setPolygonFeatures] = useState([]);

  // effect:audited — imperative mapbox draw event listeners for spatial filtering + feature-state fading
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || isGraphExpanded !== activeModule) {
      if (map && map.getSource(sourceId)) {
        clearFading(map, sourceId, layerIds, labelLayerIds);
      }
      setPolygonFeatures([]);
      return;
    }

    const computeSelection = () => {
      const draw = drawRef?.current;
      if (!draw || !featureGeoJSON?.features?.length) {
        clearFading(map, sourceId, layerIds, labelLayerIds);
        setPolygonFeatures([]);
        return;
      }

      const polygons = draw.getAll?.()?.features || [];
      if (!polygons.length) {
        clearFading(map, sourceId, layerIds, labelLayerIds);
        setPolygonFeatures([]);
        return;
      }

      // Start from features that pass the major roads filter if active
      const candidates = showMajorRoadsOnly
        ? featureGeoJSON.features.filter(f => (f.properties?.capacity ?? 0) > 1200)
        : featureGeoJSON.features;

      const filtered = candidates.filter((f) => {
        if (!f.geometry) return false;
        return polygons.some((p) => {
          try { return booleanIntersects(f, p); } catch { return false; }
        });
      });

      setPolygonFeatures(filtered);
      onPolygonChange?.();

      // Remove existing single-feature highlight
      if (map.getLayer('network-highlight')) map.removeLayer('network-highlight');
      if (map.getSource('network-highlight')) map.removeSource('network-highlight');

      // Apply feature-state fading
      if (map.getSource(sourceId) && filtered.length > 0) {
        map.removeFeatureState({ source: sourceId });

        const filteredSet = new Set(filtered);
        featureGeoJSON.features.forEach((f, i) => {
          if (filteredSet.has(f)) {
            map.setFeatureState({ source: sourceId, id: i }, { inPolygon: true });
          }
        });

        applyFading(map, layerIds, labelLayerIds);
      }
    };

    map.on('draw.create', computeSelection);
    map.on('draw.update', computeSelection);
    map.on('draw.delete', computeSelection);
    computeSelection();

    return () => {
      map.off('draw.create', computeSelection);
      map.off('draw.update', computeSelection);
      map.off('draw.delete', computeSelection);
    };
  }, [mapRef, drawRef, featureGeoJSON, isGraphExpanded, showMajorRoadsOnly]);

  return polygonFeatures;
}
