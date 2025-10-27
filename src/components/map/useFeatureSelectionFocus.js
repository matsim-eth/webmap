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

// Helper function to build comparison filter expressions for Mapbox
const buildComparisonFilter = (operator, value, expression) => {
  switch(operator) {
    case '>':
      return [">", expression, value];
    case '<':
      return ["<", expression, value];
    case '>=':
      return [">=", expression, value];
    case '<=':
      return ["<=", expression, value];
    default:
      return ["==", expression, value];
  }
};

// Helper function to get property name for column
const getPropertyName = (column) => {
  const columnMap = {
    "capacity": "per_id_capacities",
    "length": "per_id_lengths", 
    "freeSpeed": "per_id_freespeeds",
    "totalVol": "per_id_daily_avgs",
    "directionId": "per_id_keys"
  };
  return columnMap[column] || null;
};

// Helper function to build comparison filter for pipe-delimited properties
const buildPipeDelimitedComparison = (operator, value, propName) => {
  // We now have min/max properties computed from pipe-delimited values
  // Map pipe-delimited properties to their min/max counterparts
  const minMaxMap = {
    "per_id_capacities": { min: "capacity_min", max: "capacity_max" },
    "per_id_lengths": { min: "length_min", max: "length_max" },
    "per_id_freespeeds": { min: "freespeed_min", max: "freespeed_max" },
    "per_id_daily_avgs": { min: "volume_min", max: "volume_max" },
  };
  
  const props = minMaxMap[propName];
  
  if (!props) {
    // Fallback for non-numeric properties - do string matching
    const valueStr = String(value);
    return [">=", ["index-of", valueStr, ["to-string", ["get", propName]]], 0];
  }
  
  // For comparison operators, check if ANY value in the pipe-delimited list matches
  // by using min/max properties:
  // - For >: show if max > value (at least one value is greater)
  // - For <: show if min < value (at least one value is less)
  // - For >=: show if max >= value
  // - For <=: show if min <= value
  // - For ==: show if min <= value <= max (value exists in range)
  
  switch(operator) {
    case '>':
      return [">", ["number", ["get", props.max], 0], value];
    case '<':
      return ["<", ["number", ["get", props.min], 999999], value];
    case '>=':
      return [">=", ["number", ["get", props.max], 0], value];
    case '<=':
      return ["<=", ["number", ["get", props.min], 999999], value];
    case '==':
      return ["all",
        ["<=", ["number", ["get", props.min], 999999], value],
        [">=", ["number", ["get", props.max], 0], value]
      ];
    default:
      return [">=", ["index-of", String(value), ["to-string", ["get", propName]]], 0];
  }
};

export default function useFeatureSelectionFocus({
  mapRef,
  mapReady,
  selection,
  query,
  selectedNetworkModes,
  isGraphExpanded,
  showMajorRoadsOnly
}) {
  const lastSelectionId = useRef(null);
  
  // Always use the shared network-highlight source and layer
  const HIGHLIGHT_SOURCE = HIGHLIGHT_SOURCE_ID;
  const HIGHLIGHT_LAYER = HIGHLIGHT_LAYER_ID;
  
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
      if (map.getSource(HIGHLIGHT_SOURCE)) {
        map
        .getSource(HIGHLIGHT_SOURCE)
        .setData({ type: 'FeatureCollection', features: [] });
      }
      lastSelectionId.current = null;
      return;
    }
    
    // Update highlight source/layer
    const featureCollection = { type: 'FeatureCollection', features: [selection.feature] };
    if (map.getSource(HIGHLIGHT_SOURCE)) {
      map.getSource(HIGHLIGHT_SOURCE).setData(featureCollection);
    } else {
      map.addSource(HIGHLIGHT_SOURCE, { type: 'geojson', data: featureCollection });
    }
    
    if (!map.getLayer(HIGHLIGHT_LAYER)) {
      // Position before network-layer if it exists, otherwise transit-volumes-layer, otherwise at top
      let beforeLayer = null;
      if (map.getLayer('network-layer')) beforeLayer = 'network-layer';
      else if (map.getLayer('transit-volumes-layer')) beforeLayer = 'transit-volumes-layer';
      
      map.addLayer(
        {
          id: HIGHLIGHT_LAYER,
          type: 'line',
          source: HIGHLIGHT_SOURCE,
          paint: {
            'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15],
            'line-color': '#00a2ff',
            'line-opacity': 1,
          },
        },
        beforeLayer
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
    
    // Detect which layers are present to determine if we're filtering network or transit
    const isTransitMode = isGraphExpanded === 'Transit' || isGraphExpanded === 'TransitVolumes';
    
    // Define layer IDs based on what's actually visible
    // Note: network-highlight is now shared between network and transit modes
    const layerIds = isTransitMode 
      ? ["transit-volumes-layer", "transit-volumes-hitbox", "network-highlight", 
         "transit-volumes-label-left", "transit-volumes-label-right", "ant-line"]
      : ["network-layer", "click-network-layer", "network-highlight", 
         "network-label-left", "network-label-right", "ant-line"];
    
    // --- Build mode filter ---
    let modeFilter = null;
    if (Array.isArray(selectedNetworkModes) && !selectedNetworkModes.includes("all")) {
      if (isTransitMode) {
        // Transit mode filter
        modeFilter = [
          "any",
          ...selectedNetworkModes.map((mode) => ["in", mode, ["get", "modes"]]),
        ];
      } else {
        // Network mode filter
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
    }
    
    // --- Build table search filter ---
    let tableFilter = null;
    
    if (query) {
      let { column, value } = query;
      
      if (column && value) {
        // Check for comparison operators (>, <, >=, <=) for numeric columns
        const numericColumns = ["capacity", "length", "freeSpeed", "totalVol", "filteredVolume"];
        const isNumericCol = numericColumns.includes(column);
        
        if (isNumericCol && /^(>=?|<=?)\s*[0-9.,]+$/.test(value)) {
          const match = value.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
          if (match) {
            const operator = match[1];
            const numValue = parseFloat(match[2].replace(/,/g, ''));
            
            if (!isNaN(numValue)) {
              if (column === "filteredVolume") {
                // Special handling for filteredVolume - check left_sum OR right_sum
                const leftFilter = buildComparisonFilter(operator, numValue, ["number", ["get", "left_sum"], 0]);
                const rightFilter = buildComparisonFilter(operator, numValue, ["number", ["get", "right_sum"], 0]);
                tableFilter = ["any", leftFilter, rightFilter];
              } else {
                // For other numeric columns, use pipe-delimited properties
                const propName = getPropertyName(column);
                if (propName) {
                  // For pipe-delimited values, we need to check if ANY value matches the comparison
                  // Convert pipe-delimited string to check each value
                  tableFilter = buildPipeDelimitedComparison(operator, numValue, propName);
                }
              }
            }
          }
        }
        
        // If no comparison operator match, proceed with normal logic
        if (!tableFilter) {
          // Column-specific search - handle semicolon-separated values with OR logic
          const values = String(value).split(/[;,]/).map(v => v.trim()).filter(v => v);
        
        if (column === "modes") {
          // Modes: contains match for any of the values
          const filters = values.map(val => {
            const valLower = val.toLowerCase();
            return [">=", ["index-of", valLower, ["downcase", ["to-string", ["get", "modes"]]]], 0];
          });
          
          tableFilter = filters.length > 1 ? ["any", ...filters] : filters[0];
          
        } else if (column === "filteredVolume") {
          // Filtered Volume: check left_sum OR right_sum directly (numeric properties)
          // Use tolerance-based matching for floating point values
          const numericValues = values
            .map(v => v.replace(/,/g, ''))
            .filter(v => !isNaN(Number(v)))
            .map(v => Number(v));
          
          if (numericValues.length > 0) {
            const tolerance = 0.05; // 0.05 tolerance for rounding
            
            const volumeFilters = numericValues.map(val => {
              const minVal = val - tolerance;
              const maxVal = val + tolerance;
              
              return [
                "any",
                // Match left_sum within tolerance
                [
                  "all",
                  [">=", ["number", ["get", "left_sum"], 0], minVal],
                  ["<=", ["number", ["get", "left_sum"], 0], maxVal]
                ],
                // Match right_sum within tolerance
                [
                  "all",
                  [">=", ["number", ["get", "right_sum"], 0], minVal],
                  ["<=", ["number", ["get", "right_sum"], 0], maxVal]
                ]
              ];
            });
            
            tableFilter = volumeFilters.length > 1 ? ["any", ...volumeFilters] : volumeFilters[0];
          }
        } else {
          // Other columns: exact match for any of the values in pipe-delimited strings
          const columnMap = {
            "capacity": "per_id_capacities",
            "length": "per_id_lengths", 
            "freeSpeed": "per_id_freespeeds",
            "totalVol": "per_id_daily_avgs",
            "directionId": "per_id_keys"
          };
          
          const propName = columnMap[column];
          if (propName) {
            // Create exact match conditions for each value
            const valueFilters = values.map(val => {
              // For exact matching in pipe-delimited strings, we need to ensure:
              // 1. Value is the entire property (no pipes)
              // 2. Value is at start followed by pipe: "val|..."
              // 3. Value is after pipe and before another pipe: "|val|"
              // 4. Value is at end after pipe: "|val"
              
              return [
                "any",
                // Entire property is just this value (no pipes)
                ["==", ["get", propName], val],
                // Value at start followed by pipe
                ["==", ["index-of", `${val}|`, ["get", propName]], 0],
                // Value in middle: preceded AND followed by pipe
                [">=", ["index-of", `|${val}|`, ["get", propName]], 0],
                // Value at end: preceded by pipe, ends the string
                [
                  "all",
                  [">=", ["index-of", `|${val}`, ["get", propName]], 0],
                  // Ensure this is at the end by checking the position
                  ["==",
                    ["+",
                      ["index-of", `|${val}`, ["get", propName]],
                      ["length", `|${val}`]
                    ],
                    ["length", ["get", propName]]
                  ]
                ]
              ];
            });
            
            // Combine with OR logic (any value matches)
            tableFilter = valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0];
          }
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
      
      // Build combined filter based on context
      let combined = null;
      
      // Start with base filters (mode + table)
      if (modeFilter && tableFilter) {
        combined = ["all", modeFilter, tableFilter];
      } else if (modeFilter) {
        combined = modeFilter;
      } else if (tableFilter) {
        combined = tableFilter;
      }
      
      // If we're in Volumes mode (not transit), enforce additional filters
      if (!isTransitMode && isGraphExpanded === 'Volumes') {
        const carFilter = ["match", ["index-of", "car", ["get", "modes"]], -1, false, true];
        const majorRoadsFilter = [">", ["get", "capacity"], 1200];
        
        // Build Volumes-specific filters
        let volumesFilters = [carFilter];
        if (showMajorRoadsOnly) {
          volumesFilters.push(majorRoadsFilter);
        }
        
        // Combine with existing filters
        if (combined) {
          combined = ["all", combined, ...volumesFilters];
        } else {
          combined = volumesFilters.length > 1 ? ["all", ...volumesFilters] : volumesFilters[0];
        }
      }
      
      map.setFilter(id, combined);
    });
  }, [mapRef, mapReady, query, selectedNetworkModes, isGraphExpanded, showMajorRoadsOnly]);
  
}
