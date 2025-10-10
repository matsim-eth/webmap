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
  query,
  selectedNetworkModes
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
  
  useEffect(() => {
    const map = mapRef?.current;
    if (!mapReady || !map) return;
    
    const layerIds = ["network-layer", "click-network-layer", "network-highlight"];
    
    // --- Build mode filter ---
    let modeFilter = null;
    if (Array.isArray(selectedNetworkModes) && !selectedNetworkModes.includes("all")) {
      modeFilter = [
        "any",
        ...selectedNetworkModes.map((mode) => [
          "match",
          ["index-of", mode, ["get", "modes"]],
          -1,
          false,
          true,
        ]),
      ];
    }
    
    // --- Build table search filter ---
    let tableFilter = null;
    
    if (query) {
      let { column, value } = query;
      
      if (column && value) {
        // Column-specific search - handle semicolon-separated values with OR logic
        const values = String(value).split(/[;,]/).map(v => v.trim()).filter(v => v);
        
        if (column === "modes") {
          // Modes: contains match for any of the values
          const filters = values.map(val => {
            const valLower = val.toLowerCase();
            return [">=", ["index-of", valLower, ["downcase", ["to-string", ["get", "modes"]]]], 0];
          });
          
          tableFilter = filters.length > 1 ? ["any", ...filters] : filters[0];
          
        } else {
          // Other columns: exact match for any of the values in pipe-delimited strings
          const columnMap = {
            "capacity": "per_id_capacities",
            "length": "per_id_lengths", 
            "freeSpeed": "per_id_freespeeds",
            "dailyAvg": "per_id_daily_avgs",
            "directionId": "per_id_keys"
          };
          
          const propName = columnMap[column];
          if (propName) {
            // Create exact match conditions for each value
            const valueFilters = values.map(val => [
              "any",
              // Single value (no pipes)
              ["==", ["get", propName], val],
              // Value at start
              ["==", ["index-of", `${val}|`, ["get", propName]], 0],
              // Value in middle or end  
              [">=", ["index-of", `|${val}`, ["get", propName]], 0]
            ]);
            
            // Combine with OR logic (any value matches)
            tableFilter = valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0];
          }
        }
        
      } else if (!column && value) {
        // All columns search - handle semicolon-separated values with OR logic
        const values = String(value).split(/[;,]/).map(v => v.trim().toLowerCase()).filter(v => v);
        
        if (values.length === 1) {
          // Single value - simple contains
          tableFilter = [">=", ["index-of", values[0], ["get", "searchable_text"]], 0];
        } else {
          // Multiple values - OR logic (feature must contain ANY of the terms)
          const valueFilters = values.map(val => 
            [">=", ["index-of", val, ["get", "searchable_text"]], 0]
          );
          
          // Use OR logic for "all columns" too
          tableFilter = ["any", ...valueFilters];
        }
      }
    }
    
    // --- Apply filters ---
    layerIds.forEach((id) => {
      if (!map.getLayer(id)) return;
      
      const combined =
      modeFilter && tableFilter
      ? ["all", modeFilter, tableFilter]
      : modeFilter || tableFilter || null;
      
      map.setFilter(id, combined);
    });
  }, [mapRef, mapReady, query, selectedNetworkModes]);
  
}
