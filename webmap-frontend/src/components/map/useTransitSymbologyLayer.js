import { useEffect } from "react";
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { booleanPointInPolygon } from '@turf/turf';

export default function useTransitSymbologyLayer({
    mapRef,
    searchCanton,
    datasetId,
    isGraphExpanded,
    highlightedLineId,
    loadWithFallback,
    showLineSymbology,
    selectedTransitModes,
    drawRef,
}) {
    const map = mapRef.current;

    // Shared helper: apply line-based opacity masking to stop layers
    const applyLineMask = (map, lineId, STOP_LAYER_ID, LABEL_LAYER_ID) => {
        if (!map.getLayer(STOP_LAYER_ID) || !map.getLayer(LABEL_LAYER_ID)) return;
        if (lineId) {
            const matchLineExpr = ["in", lineId, ["get", "line_ids"]];
            map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", ["case", matchLineExpr, 0.9, 0.1]);
            map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", ["case", matchLineExpr, 1.0, 0.1]);
            map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", ["case", matchLineExpr, 1.0, 0.1]);
        } else {
            map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", 0.9);
            map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", 1);
            map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", 1);
        }
    };
    
    // === Stops Layer ===
    useEffect(() => {
        if (!map || !searchCanton || isGraphExpanded !== "TransitVolumes") return;
        
        const STOP_SOURCE_ID = "transit-symbology-stops";
        const STOP_LAYER_ID = "transit-symbology-stops";
        const STOP_LABEL_LAYER_ID = "transit-symbology-stops-label";
        
        const removeStopLayers = () => {
            safeRemoveLayer(map, [STOP_LAYER_ID, STOP_LABEL_LAYER_ID]);
            safeRemoveSource(map, STOP_SOURCE_ID);
        };
        
        if (!showLineSymbology) {
            removeStopLayers();
            return;
        }
        
        const loadStops = async () => {
            try {
                const stopsPath = `matsim/transit/stops_by_canton/${searchCanton}_stops.geojson`;
                const stopsGeo = await loadWithFallback(stopsPath);
                
                // safely parse .lines if it's a string
                stopsGeo.features.forEach((f) => {
                    let parsed = [];
                    if (typeof f.properties.lines === "string") {
                        try {
                            parsed = JSON.parse(f.properties.lines);
                        } catch {
                            parsed = [];
                        }
                    } else if (Array.isArray(f.properties.lines)) {
                        parsed = f.properties.lines;
                    }
                    
                    // Ensure it’s stored as objects
                    f.properties.lines = parsed;
                    
                    // Add this: flattened line_id list
                    f.properties.line_ids = parsed.map((l) => l.line_id);
                });
                
                
                map.addSource(STOP_SOURCE_ID, {
                    type: "geojson",
                    data: stopsGeo,
                    generateId: true,
                });
                
                map.addLayer({
                    id: STOP_LAYER_ID,
                    type: "circle",
                    source: STOP_SOURCE_ID,
                    paint: {
                        "circle-radius": 3,
                        "circle-color": "#ff8800",
                        "circle-stroke-color": "#333",
                        "circle-stroke-width": 1,
                        "circle-opacity": 0.9,
                    },
                });
                
                map.addLayer({
                    id: STOP_LABEL_LAYER_ID,
                    type: "symbol",
                    source: STOP_SOURCE_ID,
                    layout: {
                        "text-field": ["get", "name"],
                        "text-size": 12,
                        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
                        "text-offset": [0, -0.8],
                        "text-anchor": "bottom-left",
                    },
                    paint: {
                        "text-color": "#222",
                        "text-halo-color": "#ffffff",
                        "text-halo-width": 1,
                    },
                    minzoom: 14,
                });
                
                // Filter by selected modes
                const modeFilter =
                selectedTransitModes && !selectedTransitModes.includes("all")
                ? [
                    "any",
                    ...selectedTransitModes.map((mode) => [
                        "match",
                        ["index-of", mode, ["get", "modes_list"]],
                        -1,
                        false,
                        true,
                    ]),
                ]
                : null;
                
                map.setFilter(STOP_LAYER_ID, modeFilter);
                map.setFilter(STOP_LABEL_LAYER_ID, modeFilter);

                // Apply line masking immediately if a line is already selected
                applyLineMask(map, highlightedLineId, STOP_LAYER_ID, STOP_LABEL_LAYER_ID);

                // Apply polygon fading if polygons are already drawn
                const polygons = drawRef?.current?.getAll?.()?.features || [];
                if (polygons.length) {
                    map.removeFeatureState({ source: STOP_SOURCE_ID });
                    for (let i = 0; i < stopsGeo.features.length; i++) {
                        const f = stopsGeo.features[i];
                        if (f.geometry?.type !== 'Point') continue;
                        const inside = polygons.some((p) => {
                            try { return booleanPointInPolygon(f.geometry, p); } catch { return false; }
                        });
                        if (inside) {
                            map.setFeatureState({ source: STOP_SOURCE_ID, id: i }, { inPolygon: true });
                        }
                    }
                    if (!highlightedLineId) {
                        const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 0.9, 0.1];
                        map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", fade);
                        map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", fade);
                        map.setPaintProperty(STOP_LABEL_LAYER_ID, "text-opacity", fade);
                    }
                }
            } catch (err) {
                console.error("Failed to load transit stops symbology", err);
            }
        };

        loadStops();
        return () => removeStopLayers();
    }, [
        mapRef,
        searchCanton,
        datasetId,
        isGraphExpanded,
        showLineSymbology,
        selectedTransitModes,
        highlightedLineId,
    ]);
    
    
    
    useEffect(() => {
        if (!map || isGraphExpanded !== "TransitVolumes") return;

        const STOP_LAYER_ID = "transit-symbology-stops";
        const LABEL_LAYER_ID = "transit-symbology-stops-label";
        const lineId = showLineSymbology ? highlightedLineId : null;

        const maskLayers = () => {
            if (lineId) {
                applyLineMask(map, lineId, STOP_LAYER_ID, LABEL_LAYER_ID);
            } else {
                const hasPolygons = drawRef?.current?.getAll?.()?.features?.length > 0;
                if (hasPolygons && map.getSource("transit-symbology-stops")) {
                    const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 0.9, 0.1];
                    if (map.getLayer(STOP_LAYER_ID)) {
                        map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", fade);
                        map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", fade);
                    }
                    if (map.getLayer(LABEL_LAYER_ID)) {
                        map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", fade);
                    }
                } else {
                    applyLineMask(map, null, STOP_LAYER_ID, LABEL_LAYER_ID);
                }
            }
        };

        maskLayers();
        map.once("idle", maskLayers);

        return () => { map.off("idle", maskLayers); };
    }, [mapRef, highlightedLineId, isGraphExpanded, showLineSymbology]);

    // Polygon fading for symbology stops in Transit Volumes
    useEffect(() => {
        if (!map || isGraphExpanded !== "TransitVolumes" || !showLineSymbology) return;

        const STOP_SOURCE_ID = "transit-symbology-stops";
        const STOP_LAYER_ID = "transit-symbology-stops";
        const LABEL_LAYER_ID = "transit-symbology-stops-label";

        const computeStopFading = () => {
            const draw = drawRef?.current;
            const source = map.getSource(STOP_SOURCE_ID);
            if (!source) return;

            const polygons = draw?.getAll?.()?.features || [];
            if (!polygons.length) {
                map.removeFeatureState({ source: STOP_SOURCE_ID });
                if (map.getLayer(STOP_LAYER_ID)) {
                    map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", 0.9);
                    map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", 1);
                }
                if (map.getLayer(LABEL_LAYER_ID)) {
                    map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", 1);
                }
                return;
            }

            const features = source._data?.features || [];
            map.removeFeatureState({ source: STOP_SOURCE_ID });
            for (let i = 0; i < features.length; i++) {
                const f = features[i];
                if (f.geometry?.type !== 'Point') continue;
                const inside = polygons.some((p) => {
                    try { return booleanPointInPolygon(f.geometry, p); } catch { return false; }
                });
                if (inside) {
                    map.setFeatureState({ source: STOP_SOURCE_ID, id: i }, { inPolygon: true });
                }
            }

            const fade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 0.9, 0.1];
            if (map.getLayer(STOP_LAYER_ID)) {
                map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", fade);
                map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", fade);
            }
            if (map.getLayer(LABEL_LAYER_ID)) {
                map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", fade);
            }
        };

        map.on('draw.create', computeStopFading);
        map.on('draw.update', computeStopFading);
        map.on('draw.delete', computeStopFading);
        computeStopFading();

        return () => {
            map.off('draw.create', computeStopFading);
            map.off('draw.update', computeStopFading);
            map.off('draw.delete', computeStopFading);
        };
    }, [mapRef, isGraphExpanded, showLineSymbology, drawRef]);
}
