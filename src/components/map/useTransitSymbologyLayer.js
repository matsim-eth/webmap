import { useEffect } from "react";

export default function useTransitSymbologyLayer({
    mapRef,
    searchCanton,
    isGraphExpanded,
    highlightedLineId,
    loadWithFallback,
    showLineSymbology,
    selectedTransitModes
}) {
    const map = mapRef.current;
    
    // === Stops Layer ===
    useEffect(() => {
        if (!map || !searchCanton || isGraphExpanded !== "TransitVolumes") return;
        
        const STOP_SOURCE_ID = "transit-symbology-stops";
        const STOP_LAYER_ID = "transit-symbology-stops";
        const STOP_LABEL_LAYER_ID = "transit-symbology-stops-label";
        
        const removeStopLayers = () => {
            [STOP_LAYER_ID, STOP_LABEL_LAYER_ID].forEach((id) => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource(STOP_SOURCE_ID)) map.removeSource(STOP_SOURCE_ID);
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

  // 💡 Add this: flattened line_id list
  f.properties.line_ids = parsed.map((l) => l.line_id);
});

                
                map.addSource(STOP_SOURCE_ID, {
                    type: "geojson",
                    data: stopsGeo,
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
            } catch (err) {
                console.error("Failed to load transit stops symbology", err);
            }
        };
        
        loadStops();
        return () => removeStopLayers();
    }, [
        mapRef,
        searchCanton,
        isGraphExpanded,
        showLineSymbology,
        selectedTransitModes,
    ]);
    
    
    // === Line Layer ===
    useEffect(() => {
        if (!map || !highlightedLineId || !showLineSymbology || isGraphExpanded !== "TransitVolumes") return;
        
        const LINE_LAYER_ID = "transit-symbology-line";
        
        const removeLineLayer = () => {
            if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
        };
        
        if (!map.getSource("transit-volumes-source")) return;
        
        const filterExpr = ["in", highlightedLineId, ["get", "line_ids"]];
        
        map.addLayer({
            id: "transit-symbology-line",
            type: "line",
            source: "transit-volumes-source",
            layout: {
                "line-join": "round",
                "line-cap": "round"
            },
            paint: {
                "line-color": [
                    "interpolate",
                    ["linear"],
                    ["get", "filtered_volume"],
                    0, "#ffffcc",
                    5, "#c2e699",
                    10, "#78c679",
                    50, "#31a354",
                    100, "#006837",
                ],
                "line-width": [
                    "interpolate",
                    ["linear"],
                    ["get", "filtered_volume"],
                    0, 1,
                    5, 3,
                    10, 5,
                    50, 7,
                    100, 10
                ],
                "line-opacity": 1.0
            },
            filter: filterExpr
        }, "transit-volumes-layer");
        
        return () => removeLineLayer();
    }, [mapRef, isGraphExpanded, highlightedLineId, showLineSymbology]);
    
    useEffect(() => {
        if (!map || isGraphExpanded !== "TransitVolumes") return;
        
        const STOP_LAYER_ID = "transit-symbology-stops";
        const LABEL_LAYER_ID = "transit-symbology-stops-label";
        
        if (!map.getLayer(STOP_LAYER_ID) || !map.getLayer(LABEL_LAYER_ID)) return;
        
        if (highlightedLineId && showLineSymbology) {
            const matchLineExpr = ["in", highlightedLineId, ["get", "line_ids"]];
            
            map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", [
                "case",
                matchLineExpr,
                0.9, // high opacity if on line
                0.2  // faded out
            ]);
            
            map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", [
                "case",
                matchLineExpr,
                1.0,
                0.2
            ]);
            
            map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", [
                "case",
                matchLineExpr,
                1.0,
                0.2
            ]);
        } else {
            // reset to default when no line is selected or symbology is off
            map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", 0.9);
            map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", 1);
            map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", 1);
        }
    }, [mapRef, highlightedLineId, isGraphExpanded, showLineSymbology]);
    
    
}
