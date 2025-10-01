import { useEffect, useRef } from 'react';

const HIGHLIGHT_SOURCE_ID = 'network-highlight';
const HIGHLIGHT_LAYER_ID = 'network-highlight';

const computeBounds = (coords) => {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  coords.forEach(([lng, lat]) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
};

export default function useFeatureSelectionFocus({
  mapRef,
  mapReady,
  selection,
}) {
  const lastSelectionId = useRef(null);

  useEffect(() => {
    const map = mapRef?.current;
    if (!mapReady || !map) return;

    // No selection: clear highlight + sidebar selection
    if (
      !selection ||
      !selection.feature ||
      !Array.isArray(selection.coords) ||
      !selection.coords.length
    ) {
      if (map.getSource(HIGHLIGHT_SOURCE_ID)) {
        map
          .getSource(HIGHLIGHT_SOURCE_ID)
          .setData({ type: 'FeatureCollection', features: [] });
      }
      lastSelectionId.current = null;
      return;
    }

    // Update highlight source/layer
    const featureCollection = { type: 'FeatureCollection', features: [selection.feature] };
    if (map.getSource(HIGHLIGHT_SOURCE_ID)) {
      map.getSource(HIGHLIGHT_SOURCE_ID).setData(featureCollection);
    } else {
      map.addSource(HIGHLIGHT_SOURCE_ID, { type: 'geojson', data: featureCollection });
    }

    if (!map.getLayer(HIGHLIGHT_LAYER_ID)) {
      map.addLayer(
        {
          id: HIGHLIGHT_LAYER_ID,
          type: 'line',
          source: HIGHLIGHT_SOURCE_ID,
          paint: {
            'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15],
            'line-color': '#00a2ff',
            'line-opacity': 1,
          },
        },
        'network-layer'
      );
    }

    // Compute id + bounds
    const bounds = computeBounds(selection.coords);
    const selectionId =
      selection.id ||
      selection.feature.id ||
      selection.feature.properties?.id ||
      selection.feature.properties?.link_id ||
      null;

    // Only react to *new* selections
    const isNew = selectionId !== lastSelectionId.current;

    if (bounds && isNew) {
      if (map.stop) map.stop();
      map.fitBounds(bounds, {
        padding: { top: 250, bottom: 250, left: 250, right: 1200 },
        duration: 1000,
      });
    }

    lastSelectionId.current = selectionId;
  }, [mapRef, mapReady, selection]);
}
