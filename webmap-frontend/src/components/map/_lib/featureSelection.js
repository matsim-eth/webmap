/**
 * Highlight-layer helpers used across modules that decorate the shared
 * `network-highlight` source/layer (or its transit-stop point counterpart).
 *
 * Layer ids are intentionally part of the public surface — other code,
 * including module-specific reset buttons, references them directly.
 */

import { addLayerOnce, safeRemoveLayer, safeRemoveSource, setOrAddSource } from './mapbox.js';

export const NETWORK_HIGHLIGHT_ID = 'network-highlight';
export const TRANSIT_HIGHLIGHT_LAYER = 'transit-highlight-layer';
export const TRANSIT_HIGHLIGHT_SOURCE = 'transit-highlight';
export const ANT_LAYER_ID = 'ant-line';
export const ANT_SOURCE_ID = 'ant-path';

/** Default paint for the network-highlight line layer. */
export const NETWORK_HIGHLIGHT_PAINT = {
  'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15],
  'line-color': '#00a2ff',
  'line-opacity': 1,
};

/**
 * Add the network-highlight source + layer for `feature` (a GeoJSON Feature
 * or null). Pass `null` / undefined to clear. `beforeId` controls insertion
 * order; the caller picks whichever underlying layer should sit above.
 * `paintOverrides` lets modules tweak line-width/color without re-deriving
 * the whole spec (e.g. LinkSpeeds widens for merged selections).
 */
export const setNetworkHighlight = (map, feature, beforeId, paintOverrides) => {
  if (!map) return;
  if (!feature) {
    clearNetworkHighlight(map);
    return;
  }
  const fc = { type: 'FeatureCollection', features: [feature] };
  setOrAddSource(map, NETWORK_HIGHLIGHT_ID, fc);
  addLayerOnce(map, {
    id: NETWORK_HIGHLIGHT_ID,
    type: 'line',
    source: NETWORK_HIGHLIGHT_ID,
    paint: { ...NETWORK_HIGHLIGHT_PAINT, ...(paintOverrides || {}) },
  }, beforeId);
};

/**
 * Empty out the network-highlight source's feature collection without
 * removing the layer. Used when the layer should remain in the map's layer
 * stack but show nothing (e.g. between selections in the same module).
 */
export const clearNetworkHighlightData = (map) => {
  if (!map) return;
  const src = map.getSource(NETWORK_HIGHLIGHT_ID);
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
};

/** Fully remove the network-highlight layer and source. */
export const clearNetworkHighlight = (map) => {
  safeRemoveLayer(map, NETWORK_HIGHLIGHT_ID);
  safeRemoveSource(map, NETWORK_HIGHLIGHT_ID);
};

/** Fully remove the transit-stop point highlight layer and source. */
export const clearTransitStopHighlight = (map) => {
  safeRemoveLayer(map, TRANSIT_HIGHLIGHT_LAYER);
  safeRemoveSource(map, TRANSIT_HIGHLIGHT_SOURCE);
};

/** Fully remove the ant-line animation layer and source. */
export const clearAntLine = (map) => {
  safeRemoveLayer(map, ANT_LAYER_ID);
  safeRemoveSource(map, ANT_SOURCE_ID);
};
