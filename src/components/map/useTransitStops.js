import { useEffect } from 'react';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

export default function useTransitStops({
  mapRef,
  dataURL,
  searchCanton,
  selectedTransitModes,
  showStopVolumeSymbology,
  setSelectedTransitStop,
  setHighlightedLineId,
  highlightedLineId,
  highlightedRouteIds,
  setHighlightedRouteIds,
  hoveredRouteId,
  isGraphExpanded,
  suppressNextSearchZoom,
  setClickedCanton
}) {
  const loadWithFallback = useLoadWithFallback(dataURL);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    
    const removeTransitStops = () => {
      ["transit-stops-layer", "transit-stops-label", "transit-highlight-layer", "transit-line-highlight", "transit-stops-hitbox"].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      
      ["transit-stops", "transit-highlight", "transit-line-highlight"].forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
      });
      
      setSelectedTransitStop(null);
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);
    };
    
    if (isGraphExpanded !== "Transit" || !searchCanton) {
      removeTransitStops();
      return;
    }
    
    const stopsPath = `matsim/transit/stops_by_canton/${searchCanton}_stops.geojson`;
    const volumePath = `matsim/transit/per_canton_counts/${searchCanton}_counts.json`;
    
    Promise.all([
      loadWithFallback(stopsPath),
      showStopVolumeSymbology ? loadWithFallback(volumePath) : Promise.resolve(null)
    ])
    .then(([geojson, volumeData]) => {
      let updatedGeoJSON = geojson;
      
      // === Inject volume into stop features ===
      if (showStopVolumeSymbology && volumeData) {
        const volumeByStopId = {};
        volumeData.forEach(entry => {
          const stopId = entry.stop_id;
          if (!volumeByStopId[stopId]) volumeByStopId[stopId] = 0;
          entry.data.forEach(dp => {
            volumeByStopId[stopId] += dp.boardings + dp.alightings;
          });
        });
        
        updatedGeoJSON = {
          ...geojson,
          features: geojson.features.map((f, i) => {
            const rawStopId = f.properties.stop_id;
            const ids = Array.isArray(rawStopId)
            ? rawStopId
            : String(rawStopId).split(",").map(id => id.trim()).filter(Boolean);
            
            const totalVolume = ids.reduce(
              (sum, id) => sum + (volumeByStopId[id] || 0), 0
            );
            
            return {
              ...f,
              id: i,
              properties: {
                ...f.properties,
                volume: totalVolume
              }
            };
          })
        };
        
      }
      
      // === Add or update source ===
      if (map.getSource("transit-stops")) {
        map.getSource("transit-stops").setData(updatedGeoJSON);
      } else {
        map.addSource("transit-stops", {
          type: "geojson",
          data: updatedGeoJSON
        });
      }
      
      // === Add layers if not yet present ===
      if (!map.getLayer("transit-stops-layer")) {
        map.addLayer({
          id: "transit-stops-layer",
          type: "circle",
          source: "transit-stops",
          paint: {
            "circle-radius": showStopVolumeSymbology
            ? [
              "interpolate", ["linear"], ["get", "volume"],
              0, 3,
              100, 5,
              500, 10,
              2500, 15,
              10000, 20
            ]
            : 3,
            "circle-color": "#ff8800",
            "circle-stroke-color": "#333",
            "circle-stroke-width": 1
          }
        });
      } else {
        // if layer already exists, update radius only
        map.setPaintProperty("transit-stops-layer", "circle-radius",
          showStopVolumeSymbology
          ? [
            "interpolate", ["linear"], ["get", "volume"],
            0, 3,
            100, 5,
            500, 10,
            2500, 15,
            10000, 20
          ]
          : 3,
        );
      }
      
      
      // change highlight on volume size toggle
      if (map.getLayer("transit-highlight-layer")) {
        
        map.setPaintProperty("transit-highlight-layer", "circle-radius",
          showStopVolumeSymbology
          ? ["interpolate", ["linear"], ["get", "volume"],
          0, 6,
          100, 8,
          500, 13,
          2500, 18,
          10000, 23
        ]
        : 6
      );
    }
    
    if (!map.getLayer("transit-stops-label")) {
      map.addLayer({
        id: "transit-stops-label",
        type: "symbol",
        source: "transit-stops",
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
          "text-offset": [0, -0.8],
          "text-anchor": "bottom-left"
        },
        paint: {
          "text-color": "#222",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1
        },
        minzoom: 14
      });
    }
    
    if (!map.getLayer("transit-stops-hitbox")) {
      map.addLayer({
        id: "transit-stops-hitbox",
        type: "circle",
        source: "transit-stops",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["get", "volume"],
            0, 10,      // larger than visible
            100, 10,
            500, 15,
            2500, 18,
            10000, 23
          ],
          "circle-opacity": 0 // invisible
        }
      });
    }
    
    // === Handle click ===
    map.on("click", "transit-stops-hitbox", (e) => {
      const features = e.features;
      if (!features || features.length === 0) return;
      
      const f = features[0];
      const combinedLines = JSON.parse(f.properties.lines);
      const combinedModes = JSON.parse(f.properties.modes_list);
      
      const { name, stop_id} = features[0].properties;
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
      
      // If choose a stop that is on the current highlighted line, keep the line selected.
      const lineIdsAtStop = combinedLines.map(l => l.line_id);
      
      let currentHighlightedLineId = null;
      if (map.getSource("transit-line-highlight")) {
        const currentData = map.getSource("transit-line-highlight")._data;
        const currentFeature = currentData?.features?.[0];
        currentHighlightedLineId = currentFeature?.properties?.line_id;
      }
      
      if (lineIdsAtStop.includes(currentHighlightedLineId)) {
        const updatedRouteIds = combinedLines
        .filter(l => l.line_id === currentHighlightedLineId)
        .map(l => l.route_id);
        
        setHighlightedRouteIds(updatedRouteIds);
        setSelectedTransitStop({
          name,
          stop_id,
          stop_ids: allStopIds,
          lines: combinedLines,
          modes_list: combinedModes
        });
      } else {
        if (map.getLayer("transit-line-highlight")) map.removeLayer("transit-line-highlight");
        if (map.getSource("transit-line-highlight")) map.removeSource("transit-line-highlight");
        setHighlightedLineId(null);
        setHighlightedRouteIds([]);
      }
      
      // Highlight clicked
      if (map.getLayer("transit-highlight-layer")) map.removeLayer("transit-highlight-layer");
      if (map.getSource("transit-highlight")) map.removeSource("transit-highlight");
      
      map.addSource("transit-highlight", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [features[0]]
        }
      });
      
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
      }, "transit-stops-layer");
      
      
      setSelectedTransitStop({
        name,
        stop_id,
        stop_ids: allStopIds,
        lines: combinedLines,
        modes_list: combinedModes
      });
    });
    
    // === Reapply filtering ===
    const modeFilter = selectedTransitModes.includes("all")
    ? null
    : [
      "any",
      ...selectedTransitModes.map((mode) => [
        "match",
        ["index-of", mode, ["get", "modes_list"]],
        -1,
        false,
        true
      ])
    ];
    
    ["transit-stops-layer", "transit-highlight-layer", "transit-stops-label", "transit-stops-hitbox"].forEach((id) => {
      if (map.getLayer(id)) {
        map.setFilter(id, modeFilter);
      }
    });
  })
  .catch(err => {
    console.error("Error loading transit data:", err);
  });
}, [isGraphExpanded, searchCanton, showStopVolumeSymbology, selectedTransitModes]);

// ADD TRANSIT LINE ---

useEffect(() => {
  const map = mapRef.current;
  if (!map) return;
  
  const ROUTE_LAYER_ID = "transit-line-highlight";
  const ROUTE_SOURCE_ID = "transit-line-highlight";
  
  if (
    !highlightedRouteIds || highlightedRouteIds.length === 0 ||
    !highlightedLineId || isGraphExpanded !== "Transit"
  ) {
    if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
    if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
    if (map.getLayer("inter-cantonal-stops")) map.removeLayer("inter-cantonal-stops");
    if (map.getLayer("inter-cantonal-stops-label")) map.removeLayer("inter-cantonal-stops-label");
    if (map.getLayer("inter-cantonal-stops-hitbox")) map.removeLayer("inter-cantonal-stops-hitbox");
    if (map.getSource("inter-cantonal-stops")) map.removeSource("inter-cantonal-stops");
    return;
  }
  
  const loadRoutes = async () => {
    const geojson = await loadWithFallback("matsim/transit/routes/transit_routes.geojson");
    const routeIdsToShow = hoveredRouteId ? [hoveredRouteId] : highlightedRouteIds;
    
    const matched = geojson.features.filter(
      (f) =>
        f.properties.line_id === highlightedLineId &&
      routeIdsToShow.includes(f.properties.route_id)
    );
    
    if (matched.length === 0) return;
    
    
    const newData = {
      type: "FeatureCollection",
      features: matched,
    };
    
    if (map.getSource(ROUTE_SOURCE_ID)) {
      map.getSource(ROUTE_SOURCE_ID).setData(newData);
    } else {
      map.addSource(ROUTE_SOURCE_ID, {
        type: "geojson",
        data: newData,
      });
      
      map.addLayer(
        {
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": "#007AFF",
            "line-width": 2,
          },
        },
        "transit-stops-layer"
      );
    }
    
    const interCantonalStopsGeo = await loadWithFallback("matsim/transit/stops_by_canton/inter_cantonal_stops.geojson");
    
    if (interCantonalStopsGeo && searchCanton) {
      const relevantRouteIds = hoveredRouteId
      ? [hoveredRouteId]
      : highlightedRouteIds;
      
      const outOfCantonStops = interCantonalStopsGeo.features.filter(f => {
        const stopCanton = f.properties.assigned_canton;
        
        // Safely parse `lines` array
        let linesList = [];
        try {
          linesList = JSON.parse(f.properties.lines);
        } catch (e) {
          linesList = f.properties.lines || [];
        }
        
        const servesRelevantRoute = linesList.some(l =>
          l.line_id === highlightedLineId && relevantRouteIds.includes(l.route_id)
        );
        
        return servesRelevantRoute && stopCanton !== searchCanton;
      });
      
      
      // Cleanup first if already exists
      if (map.getLayer("inter-cantonal-stops")) map.removeLayer("inter-cantonal-stops");
      if (map.getLayer("inter-cantonal-stops-label")) map.removeLayer("inter-cantonal-stops-label");
      if (map.getLayer("inter-cantonal-stops-hitbox")) map.removeLayer("inter-cantonal-stops-hitbox");
      if (map.getSource("inter-cantonal-stops")) map.removeSource("inter-cantonal-stops");
      
      if (outOfCantonStops.length > 0) {
        map.addSource("inter-cantonal-stops", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: outOfCantonStops
          }
        });
        
        map.addLayer({
          id: "inter-cantonal-stops",
          type: "circle",
          source: "inter-cantonal-stops",
          paint: {
            "circle-radius": showStopVolumeSymbology
            ? [
              "interpolate", ["linear"], ["get", "volume"],
              0, 3,
              100, 5,
              500, 10,
              2500, 15,
              10000, 20
            ]
            : 3,
            "circle-color": "#b0b0b0",
            "circle-stroke-color": "#333",
            "circle-stroke-width": 1
          }
        }, "transit-stops-layer");
        
        map.addLayer({
          id: "inter-cantonal-stops-label",
          type: "symbol",
          source: "inter-cantonal-stops",
          layout: {
            "text-field": ["get", "name"],
            "text-size": 12,
            "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
            "text-offset": [0, -0.8],
            "text-anchor": "bottom-left"
          },
          paint: {
            "text-color": "#222",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1
          },
          minzoom: 14
        });
        
        map.addLayer({
          id: "inter-cantonal-stops-hitbox",
          type: "circle",
          source: "inter-cantonal-stops",
          paint: {
            "circle-radius": showStopVolumeSymbology
            ? [
              "interpolate", ["linear"], ["get", "volume"],
              0, 10,      // larger than visible
              100, 10,
              500, 15,
              2500, 18,
              10000, 23
            ]
            : 10,
            "circle-opacity": 0 // invisible
          }
        });
        
        map.on("click", "inter-cantonal-stops-hitbox", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          
          const { stop_id, name, assigned_canton, lines, modes_list } = f.properties;
          
          let allStopIds;
          if (Array.isArray(stop_id)) {
            allStopIds = stop_id;
          } else {
            try {
              allStopIds = JSON.parse(stop_id);
            } catch {
              allStopIds = String(stop_id).split(",").map(id => id.trim());
            }
          }
          
          suppressNextSearchZoom.current = true;
          setClickedCanton(assigned_canton);
          
          // delay re-selecting until the canton is loaded
          setTimeout(() => {         
            const updatedRouteIds = JSON.parse(lines)
            .filter(l => l.line_id === highlightedLineId)
            .map(l => l.route_id);
            
            setHighlightedLineId(highlightedLineId);
            setHighlightedRouteIds(updatedRouteIds);
            
            setSelectedTransitStop({
              name,
              stop_id,
              stop_ids: allStopIds,
              lines: JSON.parse(lines),
              modes_list: JSON.parse(modes_list),
            });
            
            if (map.getLayer("transit-highlight-layer")) map.removeLayer("transit-highlight-layer");
            if (map.getSource("transit-highlight")) map.removeSource("transit-highlight");
            
            map.addSource("transit-highlight", {
              type: "geojson",
              data: {
                type: "FeatureCollection",
                features: [f]
              }
            });
            
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
            }, "transit-stops-layer");
          }, 500); // slight delay to let new canton data load
        });
        
      }
    }
  };
  
  loadRoutes();
}, [highlightedRouteIds, showStopVolumeSymbology, highlightedLineId, hoveredRouteId, isGraphExpanded]);

// handle search-based zooming
useEffect(() => {
  const map = mapRef.current;
  if (searchCanton && map) {
    
    if (isGraphExpanded === "Transit") {
      if (map.getLayer("transit-highlight-layer")) map.removeLayer("transit-highlight-layer");
      if (map.getSource("transit-highlight")) map.removeSource("transit-highlight");
      
      setSelectedTransitStop(null);
    }
  }
}, [searchCanton]); // only update when searchCanton updates
}
