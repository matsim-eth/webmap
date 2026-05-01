import { useEffect } from 'react';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';

const ICS_LAYERS = ['inter-cantonal-stops', 'inter-cantonal-stops-label', 'inter-cantonal-stops-hitbox'];
const ICS_SOURCE = 'inter-cantonal-stops';

const removeInterCantonalStops = (map) => {
    safeRemoveLayer(map, ICS_LAYERS);
    safeRemoveSource(map, ICS_SOURCE);
};

const clearTransitLineDisplay = (map) => {
    if (map.getSource('transit-line-display')) {
        map.getSource('transit-line-display').setData({ type: 'FeatureCollection', features: [] });
    }
};

export default function useTransitLines(
    mapRef, 
    highlightedRouteIds,
    highlightedLineId,
    hoveredRouteId,
    isGraphExpanded,
    loadWithFallback,
    searchCanton,
    showStopVolumeSymbology,
    selectedTransitModes,
    setClickedCanton,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitStop,
    suppressNextSearchZoom
) {
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        
        // Clean up transit-line-display and inter-cantonal stops when leaving Transit mode
        if (isGraphExpanded !== "Transit") {
            safeRemoveLayer(map, 'transit-line-display');
            safeRemoveSource(map, 'transit-line-display');
            removeInterCantonalStops(map);
            return;
        }

        // Clear highlight only if highlightedLineId is explicitly null/empty
        // (Allow highlightedRouteIds to be empty temporarily during stop selection)
        if (!highlightedLineId) {
                if (map.getLayer("transit-line-display")) {
                    clearTransitLineDisplay(map);
                }
                removeInterCantonalStops(map);
                return;
            }
            
            // If we have a line ID but no route IDs yet, skip rendering (waiting for route IDs to be set)
            if (!highlightedRouteIds || highlightedRouteIds.length === 0) {
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
                
                // Use transit-line-display to show the selected transit route
                if (map.getSource("transit-line-display")) {
                    map.getSource("transit-line-display").setData(newData);
                } else {
                    map.addSource("transit-line-display", {
                        type: "geojson",
                        data: newData,
                    });
                    
                    // Position before transit-stops-layer if it exists
                    let beforeLayer = null;
                    if (map.getLayer('transit-stops-layer')) beforeLayer = 'transit-stops-layer';
                    else if (map.getLayer('network-layer')) beforeLayer = 'network-layer';
                    
                    map.addLayer(
                        {
                            id: "transit-line-display",
                            type: "line",
                            source: "transit-line-display",
                            layout: {
                                "line-join": "round",
                                "line-cap": "round",
                            },
                            paint: {
                                "line-color": "#00a2ff",
                                "line-width": 2,
                            },
                        },
                        beforeLayer
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
                    removeInterCantonalStops(map);
                    
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
                                    "interpolate", ["linear"], ["to-number", ["get", "volume"], 0],
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
                                    "interpolate", ["linear"], ["to-number", ["get", "volume"], 0],
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
                                
                                safeRemoveLayer(map, 'transit-highlight-layer');
                                safeRemoveSource(map, 'transit-highlight');
                                
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

        // Clear highlighted line if the current mode filter excludes its mode
        useEffect(() => {
            const map = mapRef.current;
            if (!highlightedLineId) return;
            if (!Array.isArray(selectedTransitModes) || selectedTransitModes.includes('all')) return;
            if (isGraphExpanded !== 'Transit') return;

            const ensure = async () => {
                try {
                    const routes = await loadWithFallback('matsim/transit/routes/transit_routes.geojson');
                    const f = routes?.features?.find(r => r?.properties?.line_id === highlightedLineId);
                    const lineMode = f?.properties?.mode && String(f.properties.mode);
                    if (lineMode && !selectedTransitModes.includes(lineMode)) {
                        // Clear highlight + layers
                        setHighlightedLineId(null);
                        setHighlightedRouteIds([]);
                        if (map) {
                            clearTransitLineDisplay(map);
                            removeInterCantonalStops(map);
                        }
                    }
                } catch (e) {
                    // ignore
                }
            };
            ensure();
        }, [selectedTransitModes, highlightedLineId, isGraphExpanded]);
        
        // reset transit line and inter-cantonal stops when canton changes
        useEffect(() => {
            const map = mapRef.current;
            if (!map) return;
            
            if(!suppressNextSearchZoom.current) {
                // Clear the transit line display on canton change
                clearTransitLineDisplay(map);
                removeInterCantonalStops(map);
            }
        }, [searchCanton]);
        
    }
