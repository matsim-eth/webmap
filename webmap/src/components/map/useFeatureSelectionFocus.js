import { useEffect, useRef } from 'react';

const HIGHLIGHT_SOURCE_ID = 'network-highlight';
const HIGHLIGHT_LAYER_ID = 'network-highlight';

const computeBounds = (coords) => {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  
  // Check if coords is a single point [lng, lat] or array of points [[lng, lat], ...]
  const isArrayOfPoints = Array.isArray(coords[0]);
  if (!isArrayOfPoints) {
    // Single point: return null (Transit stops shouldn't use this function)
    return null;
  }
  
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
  showMajorRoadsOnly,
  showStopVolumeSymbology
}) {
  const lastSelectionId = useRef(null);
  
  // Always use the shared network-highlight source and layer
  const HIGHLIGHT_SOURCE = HIGHLIGHT_SOURCE_ID;
  const HIGHLIGHT_LAYER = HIGHLIGHT_LAYER_ID;
  
  useEffect(() => {
    const map = mapRef?.current;
    if (!mapReady || !map) return;
    
    // Determine if we're dealing with Transit stops (points) or network/transit links (lines)
    const isTransitStops = isGraphExpanded === 'Transit';
    
    // No selection: clear highlights
    if (
      !selection ||
      !selection.feature ||
      !Array.isArray(selection.coords) ||
      !selection.coords.length
    ) {
      // Clear line-based highlight
      if (map.getSource(HIGHLIGHT_SOURCE)) {
        map.getSource(HIGHLIGHT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
      }
      
      // Clear transit stops highlight
      if (map.getLayer("transit-highlight-layer")) {
        map.removeLayer("transit-highlight-layer");
      }
      if (map.getSource("transit-highlight")) {
        map.removeSource("transit-highlight");
      }
      
      lastSelectionId.current = null;
      return;
    }
    
    // Handle Transit stops separately (points)
    if (isTransitStops) {
      // Clear line-based highlight
      if (map.getSource(HIGHLIGHT_SOURCE)) {
        map.getSource(HIGHLIGHT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
      }
      
      // Remove existing transit highlight
      if (map.getLayer("transit-highlight-layer")) {
        map.removeLayer("transit-highlight-layer");
      }
      if (map.getSource("transit-highlight")) {
        map.removeSource("transit-highlight");
      }
      
      // Add new transit highlight source and layer
      map.addSource("transit-highlight", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [selection.feature]
        }
      });
      
      // Position before transit-stops-layer
      let beforeLayer = map.getLayer("transit-stops-layer") ? "transit-stops-layer" : null;
      
      map.addLayer({
        id: "transit-highlight-layer",
        type: "circle",
        source: "transit-highlight",
        paint: {
          "circle-radius": showStopVolumeSymbology
          ? [
            "interpolate", ["linear"], ["get", "volume"],
            0, 6,
            100, 8,
            500, 13,
            2500, 18,
            10000, 23
          ]
          : 6,
          "circle-color": "#00ffff",
        }
      }, beforeLayer);
      
      // Zoom to stop if requested
      if (selection.coords.length === 2) {
        const [lng, lat] = selection.coords;
        
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          const offset = 0.005;
          const bounds = [
            [lng - offset, lat - offset],
            [lng + offset, lat + offset]
          ];
          
          const selectionId =
            selection.id ||
            selection.feature.id ||
            selection.feature.properties?.stop_id ||
            selection.feature.properties?.name ||
            null;
          
          const isNew = selectionId !== lastSelectionId.current;
          
          if (isNew) {
            if (map.stop) map.stop();
            map.fitBounds(bounds, {
              padding: { top: 150, bottom: 150, left: 150, right: 800 },
              duration: 1000,
              maxZoom: 16,
            });
            lastSelectionId.current = selectionId;
          }
        }
      }
      
      return;
    }
    
    // Handle network/transit links (lines)
    // Clear transit stops highlight
    if (map.getLayer("transit-highlight-layer")) {
      map.removeLayer("transit-highlight-layer");
    }
    if (map.getSource("transit-highlight")) {
      map.removeSource("transit-highlight");
    }
    
    // Update line highlight source/layer
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
    
    // Compute bounds and zoom (only for non-Transit modules)
    if (isGraphExpanded !== 'Transit') {
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
    }
  }, [mapRef, mapReady, selection, isGraphExpanded, showStopVolumeSymbology]);
  
  // Clear highlights when switching between module groups
  // Groups: Network/Volumes (share highlights), TransitVolumes (separate), Transit (separate)
  const previousModule = useRef(null);
  useEffect(() => {
    const map = mapRef?.current;
    if (!mapReady || !map) return;
    
    const getModuleGroup = (module) => {
      if (module === 'Network' || module === 'Volumes') return 'network';
      if (module === 'TransitVolumes') return 'transitVolumes';
      if (module === 'Transit') return 'transit';
      return null;
    };
    
    const currentGroup = getModuleGroup(isGraphExpanded);
    const previousGroup = getModuleGroup(previousModule.current);
    
    // Only clear if switching between different module groups
    if (currentGroup !== previousGroup && previousGroup !== null) {
      if (currentGroup === 'transit') {
        // Switching TO Transit: clear network highlights
        if (map.getSource(HIGHLIGHT_SOURCE)) {
          map.getSource(HIGHLIGHT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
        }
      } else if (previousGroup === 'transit') {
        // Switching FROM Transit: clear transit highlights
        if (map.getLayer("transit-highlight-layer")) {
          map.removeLayer("transit-highlight-layer");
        }
        if (map.getSource("transit-highlight")) {
          map.removeSource("transit-highlight");
        }
      } else {
        // Switching between network/transitVolumes groups: clear network highlights
        if (map.getSource(HIGHLIGHT_SOURCE)) {
          map.getSource(HIGHLIGHT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
        }
      }
      
      // Reset selection ID when switching module groups
      lastSelectionId.current = null;
    }
    
    previousModule.current = isGraphExpanded;
  }, [mapRef, mapReady, isGraphExpanded]);
  
  useEffect(() => {
    const map = mapRef?.current;
    if (!mapReady || !map) return;
    
    // Detect which layers are present to determine if we're filtering network, transit volumes, or transit stops
    const isTransitVolumesMode = isGraphExpanded === 'TransitVolumes';
    const isTransitStopsMode = isGraphExpanded === 'Transit';
    
    // Define layer IDs based on what's actually visible
    // Note: network-highlight is now shared between network and transit modes
    const layerIds = isTransitVolumesMode 
      ? ["transit-volumes-layer", "transit-volumes-hitbox", "network-highlight", 
         "transit-volumes-label-left", "transit-volumes-label-right", "ant-line"]
      : isTransitStopsMode
      ? ["transit-stops-layer", "transit-stops-label", "transit-stops-hitbox", "transit-highlight-layer"]
      : ["network-layer", "click-network-layer", "network-highlight", 
         "network-label-left", "network-label-right", "ant-line"];
    
    // --- Build mode filter ---
    let modeFilter = null;
    if (Array.isArray(selectedNetworkModes) && !selectedNetworkModes.includes("all")) {
      if (isTransitVolumesMode) {
        // Transit volumes mode filter
        modeFilter = [
          "any",
          ...selectedNetworkModes.map((mode) => ["in", mode, ["get", "modes"]]),
        ];
      } else if (isTransitStopsMode) {
        // Transit stops mode filter - check modes_list array
        modeFilter = [
          "any",
          ...selectedNetworkModes.map((mode) => [
            "match",
            ["index-of", mode, ["get", "modes_list"]],
            -1,
            false,
            true,
          ]),
        ];
      } else {
        // Network mode filter: wrap with commas for exact matching (prevents "car" matching "cable car")
        const wrappedModes = ["concat", ",", ["get", "modes"], ","];
        modeFilter = [
          "any",
          ...selectedNetworkModes.map((mode) => [
            ">=",
            ["index-of", `,${mode},`, wrappedModes],
            0,
          ]),
        ];
      }
    }
    
    // --- Build table search filter ---
    let tableFilter = null;
    
    if (query) {
      let { column, value } = query;
      
      if (value) {
        // Transit stops have different columns than network/transit volumes
        if (isTransitStopsMode) {
          // Handle "All columns" search for Transit stops
          if (!column) {
            // Search across all fields: stop name, modes, line count, boardings, alightings
            // Split on comma/semicolon
            const hasSemicolon = value.includes(';');
            const values = String(value).split(hasSemicolon ? ';' : ',').map(v => v.trim()).filter(v => v);
            
            if (values.length > 0) {
              // Helper to generate accent variations
              const generateAccentVariations = (term) => {
                const accentVariations = {
                  'a': ['a', 'ä', 'à', 'â'],
                  'e': ['e', 'ë', 'è', 'é', 'ê'],
                  'i': ['i', 'ï', 'î'],
                  'o': ['o', 'ö', 'ô'],
                  'u': ['u', 'ü', 'ù', 'û'],
                  'c': ['c', 'ç']
                };
                
                const lower = term.toLowerCase();
                let variations = [lower];
                
                // For each character position in the term
                for (let i = 0; i < lower.length; i++) {
                  const char = lower[i];
                  const accents = accentVariations[char];
                  
                  if (accents) {
                    // Generate new variations by replacing this character with each accent
                    const newVariations = [];
                    for (const variant of variations) {
                      for (const accent of accents) {
                        if (accent !== char) {
                          newVariations.push(variant.substring(0, i) + accent + variant.substring(i + 1));
                        }
                      }
                    }
                    variations.push(...newVariations);
                  }
                }
                
                // Return unique variations, limit to reasonable number
                return [...new Set(variations)].slice(0, 20);
              };
              
              const valueFilters = values.map(val => {
                const variations = generateAccentVariations(val);
                
                // For "All columns" search, check the searchable_text pipe-delimited property
                // This includes: stopName|modes|lineCount|boardings|alightings (all lowercase)
                // Also check accent variations of the search term
                const filters = variations.map(v => 
                  [">=", ["index-of", v, ["get", "searchable_text"]], 0]
                );
                
                // Match if ANY variation is found in searchable_text
                return filters.length > 1 ? ["any", ...filters] : filters[0];
              });
              
              // Combine with AND or OR logic based on delimiter
              tableFilter = hasSemicolon && valueFilters.length > 1 
                ? ["all", ...valueFilters] 
                : (valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0]);
            }
          } else if (column) {
          // Column-specific search for Transit stops
          // Transit stops columns: stopName, modes, lineCount, boardings, alightings
          const numericColumns = ["lineCount", "boardings", "alightings"];
          const isNumericCol = numericColumns.includes(column);
          
          // Check for comparison operators (>, <, >=, <=) for numeric columns
          if (isNumericCol && /^(>=?|<=?)\s*[0-9.,]+$/.test(value)) {
            const match = value.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
            if (match) {
              const operator = match[1];
              const numValue = parseFloat(match[2].replace(/,/g, ''));
              
              if (!isNaN(numValue)) {
                const propMap = {
                  "lineCount": "line_ids", // line_ids is an array, need to use length
                  "boardings": "boardings",
                  "alightings": "alightings"
                };
                const propName = propMap[column];
                
                if (propName) {
                  // Special handling for lineCount - need to check array length
                  if (column === "lineCount") {
                    tableFilter = buildComparisonFilter(operator, numValue, ["length", ["get", "line_ids"]]);
                  } else {
                    tableFilter = buildComparisonFilter(operator, numValue, ["number", ["get", propName], 0]);
                  }
                }
              }
            }
          }
          
          // If no comparison operator, handle normal value matching
          if (!tableFilter) {
            // Split on semicolon for AND logic, comma for OR logic
            const hasSemicolon = value.includes(';');
            const values = String(value).split(hasSemicolon ? ';' : ',').map(v => v.trim()).filter(v => v);
            
            if (values.length === 0) return;
            
            if (column === "modes") {
              // Modes: check if mode exists in modes_list array
              const filters = values.map(val => {
                const valLower = val.toLowerCase();
                return [">=", ["index-of", valLower, ["downcase", ["to-string", ["get", "modes_list"]]]], 0];
              });
              tableFilter = hasSemicolon && filters.length > 1 ? ["all", ...filters] : (filters.length > 1 ? ["any", ...filters] : filters[0]);
            } else if (column === "stopName") {
              // Stop name: contains match with accent normalization support
              // Generate variations with all possible accent combinations
              const generateAccentVariations = (term) => {
                const accentVariations = {
                  'a': ['a', 'ä', 'à', 'â'],
                  'e': ['e', 'ë', 'è', 'é', 'ê'],
                  'i': ['i', 'ï', 'î'],
                  'o': ['o', 'ö', 'ô'],
                  'u': ['u', 'ü', 'ù', 'û'],
                  'c': ['c', 'ç']
                };
                
                const lower = term.toLowerCase();
                let variations = [lower];
                
                // For each character position in the term
                for (let i = 0; i < lower.length; i++) {
                  const char = lower[i];
                  const accents = accentVariations[char];
                  
                  if (accents) {
                    // Generate new variations by replacing this character with each accent
                    const newVariations = [];
                    for (const variant of variations) {
                      for (const accent of accents) {
                        if (accent !== char) {
                          newVariations.push(variant.substring(0, i) + accent + variant.substring(i + 1));
                        }
                      }
                    }
                    variations.push(...newVariations);
                  }
                }
                
                // Return unique variations, limit to reasonable number
                return [...new Set(variations)].slice(0, 20);
              };
              
              const filters = values.flatMap(val => {
                const variations = generateAccentVariations(val);
                // Create a filter for each variation
                return variations.map(v => 
                  [">=", ["index-of", v, ["downcase", ["to-string", ["get", "name"]]]], 0]
                );
              });
              
              // Combine all variation filters with OR (any match is good)
              tableFilter = hasSemicolon && values.length > 1 
                ? ["all", ...values.map((val, idx) => {
                    const variations = generateAccentVariations(val);
                    const varFilters = variations.map(v => 
                      [">=", ["index-of", v, ["downcase", ["to-string", ["get", "name"]]]], 0]
                    );
                    return ["any", ...varFilters];
                  })]
                : (filters.length > 1 ? ["any", ...filters] : filters[0]);
            } else if (isNumericCol) {
              // Numeric columns: exact match with tolerance
              const numericValues = values
                .map(v => v.replace(/,/g, ''))
                .filter(v => !isNaN(Number(v)))
                .map(v => Number(v));
              
              if (numericValues.length > 0) {
                const tolerance = 0.05;
                const propMap = {
                  "lineCount": "line_ids", // line_ids is an array
                  "boardings": "boardings",
                  "alightings": "alightings"
                };
                const propName = propMap[column];
                
                const numFilters = numericValues.map(val => {
                  const minVal = val - tolerance;
                  const maxVal = val + tolerance;
                  
                  // Special handling for lineCount - check array length
                  if (column === "lineCount") {
                    return [
                      "all",
                      [">=", ["length", ["get", "line_ids"]], minVal],
                      ["<=", ["length", ["get", "line_ids"]], maxVal]
                    ];
                  } else {
                    return [
                      "all",
                      [">=", ["number", ["get", propName], 0], minVal],
                      ["<=", ["number", ["get", propName], 0], maxVal]
                    ];
                  }
                });
                tableFilter = hasSemicolon && numFilters.length > 1 ? ["all", ...numFilters] : (numFilters.length > 1 ? ["any", ...numFilters] : numFilters[0]);
              }
            }
          }
          } // End of else if (column) for Transit stops
        } else {
          // Network and TransitVolumes columns
          
          // Handle "All columns" search for Network/TransitVolumes
          if (!column) {
            // Search in searchable_text (pipe-delimited: directionId|capacity|length|freeSpeed|totalVol)
            const hasSemicolon = value.includes(';');
            const values = String(value).split(hasSemicolon ? ';' : ',').map(v => v.trim().toLowerCase()).filter(v => v);
            
            if (values.length > 0) {
              const valueFilters = values.map(val => 
                [
                  "any",
                  [">=", ["index-of", val, ["get", "searchable_text"]], 0],
                  [">=", ["index-of", val, ["downcase", ["to-string", ["get", "modes"]]]], 0]
                ]
              );
              
              // Use OR logic for comma-separated, AND logic for semicolon-separated
              tableFilter = hasSemicolon && values.length > 1 
                ? ["all", ...valueFilters]
                : (values.length > 1 ? ["any", ...valueFilters] : valueFilters[0]);
            }
          } else {
          // Column-specific search for Network/TransitVolumes
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
                // For numeric columns, we need numeric comparison (50 should match 50.0)
                // For directionId, we need exact string matching
                const isNumericProperty = column !== "directionId";
                
                if (isNumericProperty) {
                  // For numeric columns, we need to check if the exact value exists in the pipe-delimited string
                  // Since numeric matching (50 should match 50.0), we use string patterns but handle decimal variants
                  const valueFilters = values.map(val => {
                    // Create patterns for both integer and decimal forms
                    // e.g., "50" should match "50", "50.0", "50.00", etc.
                    const patterns = [
                      val,                    // exact: "50"
                      `${val}.0`,             // with .0: "50.0"
                      `${val}.00`,            // with .00: "50.00"
                    ];
                    
                    // For each pattern, check if it exists as a complete item in pipe-delimited string
                    // To avoid matching "80" in "800", we ONLY check for:
                    // 1. Entire string equals the pattern (no pipes at all)
                    // 2. Pattern followed by | at position 0: "pattern|..."
                    // 3. Pattern surrounded by pipes: "|pattern|"
                    // 4. Pattern preceded by | at the very end: "...|pattern"
                    const patternChecks = patterns.map(pattern => [
                  "any",
                  // Entire property is just this value (no pipes)
                  ["==", ["get", propName], pattern],
                  // Value at start followed by pipe: "pattern|..." (must be at position 0)
                  [
                    "all",
                    ["==", ["index-of", `${pattern}|`, ["get", propName]], 0],
                    // Ensure the pattern| is actually followed by something, not "pattern0|"
                    ["==", ["index-of", "|", ["get", propName]], ["length", pattern]]
                  ],
                  // Value in middle: "|pattern|"
                  [">=", ["index-of", `|${pattern}|`, ["get", propName]], 0],
                  // Value at end: "|pattern" and check it's actually at the end
                  [
                    "all",
                    [">=", ["index-of", `|${pattern}`, ["get", propName]], 0],
                    ["==",
                      ["+",
                        ["index-of", `|${pattern}`, ["get", propName]],
                        ["length", `|${pattern}`]
                      ],
                      ["length", ["get", propName]]
                    ]
                  ]
                ]);
                    
                    // Match if ANY pattern variant is found
                    return ["any", ...patternChecks];
                  });
                  
                  tableFilter = valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0];
                } else {
                  // For directionId (string), do exact string matching in pipe-delimited string
                  const valueFilters = values.map(val => {
                    return [
                      "any",
                      // Entire property is just this value (no pipes)
                      ["==", ["get", propName], val],
                      // Value at start followed by pipe
                      ["==", ["index-of", `${val}|`, ["get", propName]], 0],
                      // Value in middle: preceded AND followed by pipe
                      [">=", ["index-of", `|${val}|`, ["get", propName]], 0],
                      // Value at end: preceded by pipe
                      [">=", ["index-of", `|${val}`, ["get", propName]], 0]
                    ];
                  });
                  
                  tableFilter = valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0];
                }
              }
            }
          }
          } // End of else (column-specific) for Network/TransitVolumes
        }
      } else if (!column && value && !tableFilter) {
        // All columns search fallback - only runs if tableFilter wasn't already set above
        // handle semicolon-separated values with OR logic
        const values = String(value).split(/[;,]/).map(v => v.trim().toLowerCase()).filter(v => v);
        
        if (isTransitStopsMode) {
          // This shouldn't run - Transit stops "All columns" is handled above
          // But keeping as fallback for safety
          if (values.length === 1) {
            tableFilter = [
              "any",
              [">=", ["index-of", values[0], ["downcase", ["to-string", ["get", "name"]]]], 0],
              [">=", ["index-of", values[0], ["downcase", ["to-string", ["get", "modes_list"]]]], 0]
            ];
          } else {
            const valueFilters = values.map(val => 
              [
                "any",
                [">=", ["index-of", val, ["downcase", ["to-string", ["get", "name"]]]], 0],
                [">=", ["index-of", val, ["downcase", ["to-string", ["get", "modes_list"]]]], 0]
              ]
            );
            tableFilter = ["any", ...valueFilters];
          }
        } else {
          // Network/TransitVolumes: search in searchable_text and modes
        if (values.length === 1) {
          // Single value - check in searchable_text OR modes
          tableFilter = [
            "any",
            [">=", ["index-of", values[0], ["get", "searchable_text"]], 0],
            [">=", ["index-of", values[0], ["downcase", ["to-string", ["get", "modes"]]]], 0]
          ];
        } else {
          // Multiple values - OR logic (feature must contain ANY of the terms in searchable_text OR modes)
          const valueFilters = values.map(val => 
            [
              "any",
              [">=", ["index-of", val, ["get", "searchable_text"]], 0],
              [">=", ["index-of", val, ["downcase", ["to-string", ["get", "modes"]]]], 0]
            ]
          );
          
          // Use OR logic for "all columns" too
          tableFilter = ["any", ...valueFilters];
        }
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
      
      // If we're in Volumes mode, enforce additional filters
      if (isGraphExpanded === 'Volumes') {
        // Exact match for "car" mode (prevents matching "cable car")
        const carFilter = [">=", ["index-of", ",car,", ["concat", ",", ["get", "modes"], ","]], 0];
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
