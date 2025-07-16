import { useEffect, useRef } from "react";

export default function useTransitVolumesLayer({
    mapRef,
    isGraphExpanded,
    searchCanton,
    timeRange,
    loadWithFallback,
    selectedTransitModes,
    setIsLoading,
    setSelectedTransitLink 
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
                },
            };
        });
    }
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map || isGraphExpanded !== "TransitVolumes" || !searchCanton) return;
        
        const removeLayers = () => {
            if (map.getLayer("transit-volumes-layer")) map.removeLayer("transit-volumes-layer");
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
                        ]
                    }
                });
                
                if (selectedTransitModes && !selectedTransitModes.includes("all")) {
                    map.setFilter("transit-volumes-layer", [
                        "any",
                        ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
                    ]);
                }
                
                const handleIdle = () => {
                    setIsLoading(false);
                    map.off("idle", handleIdle);
                };
                map.on("idle", handleIdle);
                
                map.on("click", "transit-volumes-layer", (e) => {
                    if (!e.features?.length) return;
                    
                    const clickedId = e.features[0].properties.id;
                    const allFeatures = map.getSource("transit-volumes-source")._data.features;
                    const fullFeature = allFeatures.find(f => f.properties.id === clickedId);
                    
                    if (!fullFeature) return;
                    
                    // Add highlight source and layer
                    if (map.getLayer("transit-volumes-highlight")) map.removeLayer("transit-volumes-highlight");
                    if (map.getSource("transit-volumes-highlight")) map.removeSource("transit-volumes-highlight");
                    
                    map.addSource("transit-volumes-highlight", {
                        type: "geojson",
                        data: {
                            type: "FeatureCollection",
                            features: [fullFeature]
                        }
                    });
                    
                    map.addLayer({
                        id: "transit-volumes-highlight",
                        type: "line",
                        source: "transit-volumes-highlight",
                        paint: {
                            "line-width": 6,
                            "line-color": "#00ffff",
                            "line-opacity": 0.85
                        }
                    });
                    
                    setSelectedTransitLink(fullFeature.properties);
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
    }, [timeRange]);
    
    useEffect(() => {
        const map = mapRef.current;
        if (!map || isGraphExpanded !== "TransitVolumes") return;
        
        if (map.getLayer("transit-volumes-layer")) {
            if (!selectedTransitModes || selectedTransitModes.includes("all")) {
                map.setFilter("transit-volumes-layer", null);
            } else {
                map.setFilter("transit-volumes-layer", [
                    "any",
                    ...selectedTransitModes.map(mode => [
                        "in", mode, ["get", "modes"]
                    ])
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
}
