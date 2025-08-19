import { useEffect } from 'react';

export default function useTransitLines(
    mapRef, 
    highlightedRouteIds,
    highlightedLineId,
    hoveredRouteId,
    isGraphExpanded,
    loadWithFallback,
    searchCanton,
    showStopVolumeSymbology,
    setClickedCanton,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitStop,
    suppressNextSearchZoom
) {
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        
        // remove current transit layers and sources
        if (!highlightedRouteIds || highlightedRouteIds.length === 0 ||
            !highlightedLineId || isGraphExpanded !== "Transit") {
                if (map.getLayer("transit-line-highlight")) map.removeLayer("transit-line-highlight");
                if (map.getSource("transit-line-highlight")) map.removeSource("transit-line-highlight");
                if (map.getLayer("inter-cantonal-stops")) map.removeLayer("inter-cantonal-stops");
                if (map.getLayer("inter-cantonal-stops-label")) map.removeLayer("inter-cantonal-stops-label");
                if (map.getLayer("inter-cantonal-stops-hitbox")) map.removeLayer("inter-cantonal-stops-hitbox");
                if (map.getSource("inter-cantonal-stops")) map.removeSource("inter-cantonal-stops");
                return;
            }
            
            // load current selected transit line and create layer on map
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
                
                if (map.getSource("transit-line-highlight")) {
                    map.getSource("transit-line-highlight").setData(newData);
                } else {
                    map.addSource("transit-line-highlight", {
                        type: "geojson",
                        data: newData,
                    });
                    
                    map.addLayer(
                        {
                            id: "transit-line-highlight",
                            type: "line",
                            source: "transit-line-highlight",
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
                
                // load inter-cantonal stops
                const interCantonalStopsGeo = await loadWithFallback("matsim/transit/stops_by_canton/inter_cantonal_stops.geojson");
                
                if (interCantonalStopsGeo && searchCanton) {
                    const relevantRouteIds = hoveredRouteId
                    ? [hoveredRouteId]
                    : highlightedRouteIds;
                    
                    // calculate stops that are outside the current canton but on the transit line
                    const outOfCantonStops = interCantonalStopsGeo.features.filter(f => {
                        const stopCanton = f.properties.assigned_canton;

                        console.log(stopCanton)
                        
                        // Safely parse lines array
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
                    
                    // Add inter-cantonal stops layer if applicable
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
                        
                        // Click handler for inter-cantonal stops
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
                            
                            // don't zoom to "new" canton of clicked on out-of-canton stop
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
        
        // reset transit line and inter-cantonal stops when canton changes
        useEffect(() => {
            const map = mapRef.current;
            if (!map) return;
            
            if(!suppressNextSearchZoom.current) {
                // Remove transit line and inter-cantonal stop layers on canton change
                if (map.getLayer("transit-line-highlight")) map.removeLayer("transit-line-highlight");
                if (map.getSource("transit-line-highlight")) map.removeSource("transit-line-highlight");
                
                if (map.getLayer("inter-cantonal-stops")) map.removeLayer("inter-cantonal-stops");
                if (map.getLayer("inter-cantonal-stops-label")) map.removeLayer("inter-cantonal-stops-label");
                if (map.getLayer("inter-cantonal-stops-hitbox")) map.removeLayer("inter-cantonal-stops-hitbox");
                if (map.getSource("inter-cantonal-stops")) map.removeSource("inter-cantonal-stops");
            }
        }, [searchCanton]);
        
    }