import { useEffect, useRef } from "react";

export default function useTransitVolumesLayer({
    mapRef,
    isGraphExpanded,
    searchCanton,
    timeRange,
    loadWithFallback,
    selectedTransitModes,
    setIsLoading,
    setSelectedTransitLink,
    showLineSymbology,
    highlightedLineId
}) {
    
    const originalGeoJSON = useRef(null);
    
    
    function computeFilteredFeatures(networkGeo, volumeJSON, timeRange) {
        const startTick = timeRange?.[0] ?? 0;
        const endTick = timeRange?.[1] ?? 96;
        
        return networkGeo.features
        .filter((f) => volumeJSON.hasOwnProperty(f.properties.id.toString()))
        .map((f) => {
            const linkId = f.properties.id.toString();
            const volumeEntry = volumeJSON[linkId];
            const { linkTotal, lines, length, freespeed, modes_list } = volumeEntry;
            
            const isFullDay = startTick === 0 && endTick === 96;
            let filtered = isFullDay ? linkTotal : 0;
            
            if (!isFullDay) {
                for (const lineId in lines) {
                    const { timeBins } = lines[lineId];
                    for (let h = startTick; h < endTick; h++) {
                        const hour = Math.floor(h / 4).toString().padStart(2, '0');
                        const minute = ((h % 4) * 15).toString().padStart(2, '0');
                        const key = `${hour}:${minute}`;
                        filtered += timeBins[key] ?? 0;
                    }
                }
            }
            
            return {
                ...f,
                properties: {
                    ...f.properties,
                    total_volume: linkTotal,
                    filtered_volume: filtered,
                    length,
                    freespeed,
                    modes: modes_list, // renamed to 'modes' for filtering logic
                    lines,
                    line_ids: Object.keys(lines),
                },
            };
        });
    }
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map || isGraphExpanded !== "TransitVolumes" || !searchCanton) return;
        
        const removeLayers = () => {
            if (map.getLayer("transit-volumes-layer")) map.removeLayer("transit-volumes-layer");
            if (map.getLayer("transit-volumes-hitbox")) map.removeLayer("transit-volumes-hitbox");
            if (map.getLayer("transit-symbology-line")) map.removeLayer("transit-symbology-line");
            
            if (map.getLayer("ant-line")) map.removeLayer("ant-line");
            if (map.getSource("ant-path")) map.removeSource("ant-path");
            
            if (map.getSource("transit-volumes-source")) map.removeSource("transit-volumes-source");
            
            if (map.getLayer("transit-volumes-highlight")) map.removeLayer("transit-volumes-highlight");
            if (map.getSource("transit-volumes-highlight")) map.removeSource("transit-volumes-highlight");
            
            setSelectedTransitLink(null);
            originalGeoJSON.current = null; 
        };
        
        const init = async () => {
            removeLayers();
            
            try {
                
                setIsLoading(true);
                
                const networkPath = `matsim/matsim_network_${searchCanton}.geojson`;
                const volumePath = `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${searchCanton}.json`;
                
                const networkGeo = await loadWithFallback(networkPath);
                const volumeJSON = await loadWithFallback(volumePath);
                
                originalGeoJSON.current = { geo: networkGeo, volumes: volumeJSON };
                
                const updatedFeatures = computeFilteredFeatures(networkGeo, volumeJSON, timeRange);
                
                map.addSource("transit-volumes-source", {
                    type: "geojson",
                    data: {
                        type: "FeatureCollection",
                        features: updatedFeatures,
                    },
                });
                
                map.addLayer({
                    id: "transit-volumes-layer",
                    type: "line",
                    source: "transit-volumes-source",
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: {
                        "line-color": [
                            "interpolate",
                            ["linear"],
                            ["get", "filtered_volume"],
                            0, "#a1d99b",
                            5, "#74c476",
                            10, "#41ab5d",
                            50, "#238b45",
                            100, "#005a32",
                        ],
                        "line-width": [
                            "interpolate",
                            ["linear"],
                            ["get", "filtered_volume"],
                            0, 3,
                            5, 5,
                            10, 7,
                            50, 9,
                            100, 11
                        ]
                    }
                }, "canton-highlight");
                
                map.addLayer({
                    id: "transit-volumes-hitbox",
                    type: "line",
                    source: "transit-volumes-source",
                    paint: {
                        "line-opacity": 0,
                        "line-width": [
                            "interpolate",
                            ["linear"],
                            ["get", "filtered_volume"],
                            0, 6,
                            5, 8,
                            10, 10,
                            50, 11,
                            100, 11
                        ]
                    }
                }, "transit-volumes-layer");
                
                if (selectedTransitModes && !selectedTransitModes.includes("all")) {
                    map.setFilter("transit-volumes-layer", [
                        "any",
                        ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
                    ]);
                    map.setFilter("transit-volumes-hitbox", [
                        "any",
                        ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
                    ]);
                    
                    if (map.getLayer("ant-line")) {
                        map.setFilter("ant-line", [
                            "any",
                            ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
                        ]);
                    }
                }
                
                const handleIdle = () => {
                    setIsLoading(false);
                    map.off("idle", handleIdle);
                };
                map.on("idle", handleIdle);
                map.on("click", "transit-volumes-hitbox", (e) => {
                    if (!e.features?.length) return;
                    
                    const clickedIds = new Set(e.features.map(f => f.properties.id));
                    const allFeatures = map.getSource("transit-volumes-source")._data.features;
                    
                    // Get full features from source
                    const fullFeatures = allFeatures.filter(f => clickedIds.has(f.properties.id));
                    if (!fullFeatures.length) return;
                    
                    // Remove previous highlight
                    if (map.getLayer("transit-volumes-highlight")) map.removeLayer("transit-volumes-highlight");
                    if (map.getSource("transit-volumes-highlight")) map.removeSource("transit-volumes-highlight");
                    
                    if (map.getLayer("ant-line")) map.removeLayer("ant-line");
                    if (map.getSource("ant-path")) map.removeSource("ant-path");
                    
                    // Highlight both directions
                    map.addSource("transit-volumes-highlight", {
                        type: "geojson",
                        data: {
                            type: "FeatureCollection",
                            features: fullFeatures
                        }
                    });
                    
                    const insertBelow = map.getLayer("transit-symbology-line") // if symbology layer is active, insert below it
                    ? "transit-symbology-line"
                    : "transit-volumes-layer";
                    
                    
                    
                    map.addLayer({
                        id: "transit-volumes-highlight",
                        type: "line",
                        source: "transit-volumes-highlight",
                        paint: {
                            "line-width": [
                                "interpolate",
                                ["linear"],
                                ["get", "filtered_volume"],
                                0, 8,
                                5, 10,
                                10, 12,
                                50, 14,
                                100, 16
                            ],
                            "line-color": "#010753"
                        }
                    }, insertBelow);
                    
                    // Pass full list of feature.properties[] directly — just like road volumes
                    const featurePropsList = fullFeatures.map(f => f.properties);
                    setSelectedTransitLink(featurePropsList); // now an array, not a dict
                });
                
            } catch (err) {
                console.warn("Failed to load transit volumes layer", err);
            }
        };
        
        init();
        
        return () => removeLayers();
    }, [isGraphExpanded, searchCanton]);
    
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map || isGraphExpanded !== "TransitVolumes" || !originalGeoJSON.current) return;
        
        const { geo, volumes } = originalGeoJSON.current;
        
        const updatedFeatures = computeFilteredFeatures(geo, volumes, timeRange);
        
        const source = map.getSource("transit-volumes-source");
        if (source) {
            source.setData({
                type: "FeatureCollection",
                features: updatedFeatures
            });
        }
        
        // Update highlighted features (if any)
        const highlightSource = map.getSource("transit-volumes-highlight");
        if (highlightSource) {
            const prevHighlightData = highlightSource._data?.features || [];
            const prevIds = new Set(prevHighlightData.map((f) => f.properties.id.toString()));
            
            const updatedHighlight = updatedFeatures.filter((f) =>
                prevIds.has(f.properties.id.toString())
        );
        
        highlightSource.setData({
            type: "FeatureCollection",
            features: updatedHighlight
        });
    }
}, [timeRange]);

useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes") return;
    
    if (map.getLayer("transit-volumes-layer")) {
        if (!selectedTransitModes || selectedTransitModes.includes("all")) {
            map.setFilter("transit-volumes-layer", null);
            map.setFilter("transit-volumes-hitbox", null);
        } else {
            map.setFilter("transit-volumes-layer", [
                "any",
                ...selectedTransitModes.map(mode => [
                    "in", mode, ["get", "modes"]
                ])
            ]);
            map.setFilter("transit-volumes-hitbox", [
                "any",
                ...selectedTransitModes.map(mode => [
                    "in", mode, ["get", "modes"]
                ])
            ]);
        }
    }
    
    if (map.getLayer("ant-line")) {
        
        if (!selectedTransitModes || selectedTransitModes.includes("all")) {
            map.setFilter("ant-line", null);
        } else {
            map.setFilter("ant-line", [
                "any",
                ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
            ]);
        }
    }
    
    if (map.getLayer("transit-volumes-highlight")) {
        if (!selectedTransitModes || selectedTransitModes.includes("all")) {
            map.setFilter("transit-volumes-highlight", null);
        } else {
            map.setFilter("transit-volumes-highlight", [
                "any",
                ...selectedTransitModes.map(mode => [
                    "in", mode, ["get", "modes"]
                ])
            ]);
        }
    }
}, [selectedTransitModes]);

// dim other lines if line selected
useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes") return;
    
    const baseLayerId = "transit-volumes-layer";
    
    if (map.getLayer(baseLayerId)) {
        const targetOpacity = highlightedLineId && showLineSymbology ? 0.2 : 1.0;
        map.setPaintProperty(baseLayerId, "line-opacity", targetOpacity);
    }
}, [highlightedLineId, showLineSymbology]);
}
