import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import cantonAlias from "../../utils/canton_alias.json";
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';


/**
* Handles PT Boardings visualization including choropleth and transit stops display.
*/
export default function usePtBoardings({
  mapRef,
  isGraphExpanded,
  selectedBoardingData,
  setHighlightedLineId,
  setHighlightedRouteIds,
  loadWithFallback,
  searchCanton,
  setSelectedTransitStop,
}) {
  // The registered stop-click handler. `map.off` only removes a listener when
  // given the SAME function reference that was passed to `map.on`, so the
  // handler must be kept here across effect runs — otherwise every canton
  // switch stacks another live handler onto the hitbox layer.
  const stopClickHandlerRef = useRef(null);

  // ------------------------- PT BOARDINGS CHOROPLETH -------------------------
  useEffect(() => {
    if (!selectedBoardingData || !mapRef.current || !mapRef.current.getSource('cantons')) return;
    const map = mapRef.current;
    
    // Only show choropleth when a specific line is selected (not 'all')
    if (!selectedBoardingData.selectedLineInfo || selectedBoardingData.selectedLine === 'all') {
      // Remove choropleth if no specific line is selected
      if (map.getLayer('boarding-choropleth')) {
        map.removeLayer('boarding-choropleth');
        map.setPaintProperty("canton-fill", "fill-opacity", 0.15);
      }
      return;
    }
    
    const lineInfo = selectedBoardingData.selectedLineInfo;

    // Calculate boarding totals by canton for the selected line
    const boardingsByCanton = {};
    
    // Get the original boarding data for this line from the global data
    // We need to access the raw data that includes boarding information by time and canton
    if (selectedBoardingData.rawLineData && selectedBoardingData.rawLineData.boardings) {
      const timeRange = selectedBoardingData.timeRange || [0, 96]; // Default full day
      const startHour = Math.floor(timeRange[0] / 4);
      const endHour = Math.ceil(timeRange[1] / 4);
      
      Object.entries(selectedBoardingData.rawLineData.boardings).forEach(([timeStr, cantonBoardings]) => {
        const hour = parseInt(timeStr.split(':')[0]);
        const minute = parseInt(timeStr.split(':')[1]);
        const timeSlot = hour + (minute / 60);
        
        // Only include boardings within the selected time range
        if (timeSlot >= startHour && timeSlot < endHour) {
          Object.entries(cantonBoardings).forEach(([canton, count]) => {
            if (!boardingsByCanton[canton]) {
              boardingsByCanton[canton] = 0;
            }
            boardingsByCanton[canton] += count;
          });
        }
      });
    }
    
    if (Object.keys(boardingsByCanton).length === 0) {
      return;
    }
    
    // Add choropleth layer if it doesn't exist
    if (!map.getLayer('boarding-choropleth')) {
      map.addLayer({
        id: 'boarding-choropleth',
        type: 'fill',
        source: 'cantons',
        paint: {
          'fill-color': '#FF0066',
          'fill-opacity': 0.6
        }
      }, 'canton-borders');
    }
    
    // Calculate max boarding value for normalization
    const allBoardingValues = Object.values(boardingsByCanton);
    const maxBoardings = Math.max(...allBoardingValues);

    // Create color expression for choropleth
    const createBoardingColorExpression = () => {
      if (maxBoardings === 0) return 'rgba(0,0,0,0)';
      
      const caseExpression = ['case'];
      
      Object.entries(boardingsByCanton).forEach(([canton, count]) => {
        const intensity = count / maxBoardings;
        
        // Use quartile-based shading similar to destination zones
        let colorIntensity;
        if (intensity <= 0.25) {
          colorIntensity = 0.25;
        } else if (intensity <= 0.5) {
          colorIntensity = 0.5;
        } else if (intensity <= 0.75) {
          colorIntensity = 0.75;
        } else {
          colorIntensity = 1.0;
        }
        
        // Interpolate from white to bright pink (#FF0066)
        const baseRgb = [255, 0, 102]; // #FF0066
        const whiteRgb = [255, 255, 255];
        
        const r = Math.round(whiteRgb[0] * (1 - colorIntensity) + baseRgb[0] * colorIntensity);
        const g = Math.round(whiteRgb[1] * (1 - colorIntensity) + baseRgb[1] * colorIntensity);
        const b = Math.round(whiteRgb[2] * (1 - colorIntensity) + baseRgb[2] * colorIntensity);
        const color = `rgb(${r},${g},${b})`;
        
        caseExpression.push(['==', ['get', 'NAME'], canton]);
        caseExpression.push(color);
      });
      
      // Transparent as default color for cantons without boarding data
      caseExpression.push('rgba(0,0,0,0)');
      return caseExpression;
    };
    
    // Apply the color expression
    map.setPaintProperty('boarding-choropleth', 'fill-color', createBoardingColorExpression());
    
    // Hide the default canton fill to show only the choropleth
    map.setPaintProperty("canton-fill", "fill-opacity", 0);
    
  }, [selectedBoardingData]);
  
  // Add mouse hover effects for boarding choropleth
  useEffect(() => {
    if (!mapRef.current || !selectedBoardingData?.selectedLineInfo) return;
    const map = mapRef.current;
    
    // Only add hover effects when we have a specific line selected
    if (selectedBoardingData.selectedLine === 'all') return;
    
    const lineInfo = selectedBoardingData.selectedLineInfo;
    const boardingsByCanton = {};
    
    // Calculate boarding totals by canton (same logic as above)
    if (selectedBoardingData.rawLineData && selectedBoardingData.rawLineData.boardings) {
      const timeRange = selectedBoardingData.timeRange || [0, 96];
      const startHour = Math.floor(timeRange[0] / 4);
      const endHour = Math.ceil(timeRange[1] / 4);
      
      Object.entries(selectedBoardingData.rawLineData.boardings).forEach(([timeStr, cantonBoardings]) => {
        const hour = parseInt(timeStr.split(':')[0]);
        const minute = parseInt(timeStr.split(':')[1]);
        const timeSlot = hour + (minute / 60);
        
        if (timeSlot >= startHour && timeSlot < endHour) {
          Object.entries(cantonBoardings).forEach(([canton, count]) => {
            if (!boardingsByCanton[canton]) {
              boardingsByCanton[canton] = 0;
            }
            boardingsByCanton[canton] += count;
          });
        }
      });
    }

    const handleMouseEnter = (e) => {
      const cantonName = e.features[0].properties.NAME;
      const boardingCount = boardingsByCanton[cantonName] || 0;
      
      if (boardingCount > 0) {
        const popupContent = `
          <div style="font-size: 12px;">
            <strong>${cantonAlias[cantonName] || cantonName}</strong><br/>
            <strong>PT Line Boardings:</strong><br/>
            <div style="font-weight: bold; color: #FF0066; margin: 4px 0;">
              Line ${lineInfo.line_name} (${lineInfo.vehicle}): ${boardingCount.toLocaleString()}
            </div>
            <div style="font-size: 11px; color: #666; border-top: 1px solid #ddd; padding-top: 4px;">
              Selected time range: ${Math.floor((selectedBoardingData.timeRange?.[0] || 0) / 4).toString().padStart(2, '0')}:${((selectedBoardingData.timeRange?.[0] || 0) % 4 * 15).toString().padStart(2, '0')} - ${Math.floor((selectedBoardingData.timeRange?.[1] || 96) / 4).toString().padStart(2, '0')}:${((selectedBoardingData.timeRange?.[1] || 96) % 4 * 15).toString().padStart(2, '0')}
            </div>
          </div>
        `;
        
        new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(popupContent)
          .addTo(map);
      }
    };
    
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      const popups = document.getElementsByClassName('mapboxgl-popup');
      if (popups.length) {
        popups[0].remove();
      }
    };
    
    if (map.getLayer('boarding-choropleth')) {
      map.on('mouseenter', 'boarding-choropleth', handleMouseEnter);
      map.on('mouseleave', 'boarding-choropleth', handleMouseLeave);
    }
    
    return () => {
      if (map.getLayer('boarding-choropleth')) {
        map.off('mouseenter', 'boarding-choropleth', handleMouseEnter);
        map.off('mouseleave', 'boarding-choropleth', handleMouseLeave);
      }
    };
  }, [selectedBoardingData]);
  
  // Hide/show boarding choropleth based on graph selection
  useEffect(() => {
    if (!mapRef.current) return;
    
    const map = mapRef.current;
    if (map.getLayer('boarding-choropleth') && isGraphExpanded !== "PtBoardings") {
      map.setPaintProperty("canton-fill", "fill-opacity", 0.15);
      map.removeLayer('boarding-choropleth');
    }
  }, [isGraphExpanded]);

  // ------------------------- PT BOARDINGS HANDLING -------------------------
  useEffect(() => {
    if (!selectedBoardingData) {
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);
      return;
    }

    // Handle selected line information from PT Boardings module
    if (selectedBoardingData.selectedLineInfo && selectedBoardingData.selectedLine !== 'all') {
      const lineInfo = selectedBoardingData.selectedLineInfo;
      // Set highlighted line and routes for the main transit line highlighting system
      if (lineInfo.line_id && lineInfo.route_ids && lineInfo.route_ids.length > 0) {
        setHighlightedLineId(lineInfo.line_id);
        setHighlightedRouteIds(lineInfo.route_ids);
      }
    } else {
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);
    }
  }, [selectedBoardingData, setHighlightedLineId, setHighlightedRouteIds]);

  // ------------------------- PT STOPS DISPLAY FOR BOARDINGS -------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    
    // Remove PT stops layers if not in PtBoardings mode or no canton selected
    if (isGraphExpanded !== "PtBoardings" || !searchCanton) {
      safeRemoveLayer(map, ["pt-boardings-stops-layer", "pt-boardings-stops-label", "pt-boardings-stops-hitbox"]);
      safeRemoveSource(map, "pt-boardings-stops");
      return;
    }
    
    // Load transit stops data for the selected canton
    const stopsPath = `matsim/transit/stops_by_canton/${searchCanton}_stops.geojson`;

    loadWithFallback(stopsPath)
      .then((geojson) => {
        // Add stop IDs to features for easier processing
        geojson.features.forEach((f, i) => {
          f.id = i;
          const lines = f.properties.lines || [];
          f.properties.line_ids = lines.map(l => l.line_id);
        });
        
        // Add or update source
        if (map.getSource("pt-boardings-stops")) {
          map.getSource("pt-boardings-stops").setData(geojson);
        } else {
          map.addSource("pt-boardings-stops", {
            type: "geojson",
            data: geojson
          });
        }
        
        // Add PT stops layer if not present
        if (!map.getLayer("pt-boardings-stops-layer")) {
          map.addLayer({
            id: "pt-boardings-stops-layer",
            type: "circle",
            source: "pt-boardings-stops",
            paint: {
              "circle-radius": 3,
              "circle-color": "#ff8800", // Orange color like in Transit module
              "circle-stroke-color": "#333",
              "circle-stroke-width": 1,
              "circle-opacity": 0.8
            }
          });
        }
        
        // Add stop labels
        if (!map.getLayer("pt-boardings-stops-label")) {
          map.addLayer({
            id: "pt-boardings-stops-label",
            type: "symbol",
            source: "pt-boardings-stops",
            layout: {
              "text-field": ["get", "name"],
              "text-size": 10,
              "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
              "text-offset": [0, -0.8],
              "text-anchor": "bottom-left"
            },
            paint: {
              "text-color": "#222",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1,
              "text-opacity": 0.7
            },
            minzoom: 13
          });
        }
        
        // Add clickable hitbox for selecting stops (no popup, just selection)
        if (!map.getLayer("pt-boardings-stops-hitbox")) {
          map.addLayer({
            id: "pt-boardings-stops-hitbox",
            type: "circle",
            source: "pt-boardings-stops",
            paint: {
              "circle-radius": 8, // Larger for easier clicking
              "circle-opacity": 0 // Invisible
            }
          });
        }
        
        // Add click handler for stop selection (for transfer matrix)
        const handleStopClick = (e) => {
          if (!e.features || e.features.length === 0) return;

          const feature = e.features[0];
          const { name, stop_id } = feature.properties;
          // Mapbox stringifies non-scalar properties; guard the parses so one
          // malformed feature can't kill stop selection for the whole canton.
          const parseList = (raw) => {
            try { return JSON.parse(raw || '[]'); } catch { return []; }
          };
          const combinedLines = parseList(feature.properties.lines);
          const combinedModes = parseList(feature.properties.modes_list);

          let allStopIds;
          if (Array.isArray(stop_id)) {
            allStopIds = stop_id;
          } else {
            try {
              allStopIds = JSON.parse(stop_id); // If it's a stringified array
            } catch {
              allStopIds = String(stop_id).split(",").map(id => id.trim());
            }
          }

          // Set selected transit stop for transfer matrix analysis
          setSelectedTransitStop({
            id: feature.id,
            name,
            stop_id,
            stop_ids: allStopIds,
            lines: combinedLines,
            modes_list: combinedModes
          });
        };

        // Swap the registered handler: off() only works with the SAME function
        // reference, so remove the previously stored one, never a fresh one.
        if (stopClickHandlerRef.current) {
          map.off("click", "pt-boardings-stops-hitbox", stopClickHandlerRef.current);
        }
        stopClickHandlerRef.current = handleStopClick;
        map.on("click", "pt-boardings-stops-hitbox", handleStopClick);

      })
      .catch(err => {
        console.error("Error loading PT stops data for PtBoardings:", err);
      });

    return () => {
      if (stopClickHandlerRef.current) {
        map.off("click", "pt-boardings-stops-hitbox", stopClickHandlerRef.current);
        stopClickHandlerRef.current = null;
      }
    };
  }, [isGraphExpanded, searchCanton, loadWithFallback, setSelectedTransitStop]);

  // ------------------------- HIGHLIGHT STOPS ON SELECTED LINE -------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "PtBoardings") return;

    const STOPS_LAYER_ID = "pt-boardings-stops-layer";
    const LABELS_LAYER_ID = "pt-boardings-stops-label";

    // Update stop highlighting based on selected boarding line
    if (selectedBoardingData?.selectedLineInfo && selectedBoardingData.selectedLine !== 'all') {
      const lineId = selectedBoardingData.selectedLineInfo.line_id;

      if (map.getLayer(STOPS_LAYER_ID) && map.getLayer(LABELS_LAYER_ID)) {
        const matchLineExpr = ["in", lineId, ["get", "line_ids"]];
        
        // Highlight stops that are on the selected line
        map.setPaintProperty(STOPS_LAYER_ID, "circle-opacity", [
          "case",
          matchLineExpr,
          1.0, // Full opacity for stops on selected line
          0.3  // Reduced opacity for other stops
        ]);
        
        map.setPaintProperty(STOPS_LAYER_ID, "circle-stroke-opacity", [
          "case",
          matchLineExpr,
          1.0,
          0.3
        ]);
        
        map.setPaintProperty(LABELS_LAYER_ID, "text-opacity", [
          "case",
          matchLineExpr,
          0.9,
          0.2
        ]);
      }
    } else {
      // No specific line selected, show all stops with normal opacity
      if (map.getLayer(STOPS_LAYER_ID) && map.getLayer(LABELS_LAYER_ID)) {
        map.setPaintProperty(STOPS_LAYER_ID, "circle-opacity", 0.8);
        map.setPaintProperty(STOPS_LAYER_ID, "circle-stroke-opacity", 1.0);
        map.setPaintProperty(LABELS_LAYER_ID, "text-opacity", 0.7);
      }
    }
    
  }, [selectedBoardingData, isGraphExpanded]);

}
