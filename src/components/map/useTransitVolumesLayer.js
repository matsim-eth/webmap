import { useEffect, useRef } from "react";

export default function useTransitVolumesLayer({
    mapRef,
    isGraphExpanded,
    searchCanton,
    timeRange,
    loadWithFallback,
    selectedTransitModes
}) {
    
    const originalGeoJSON = useRef(null);
    
    
    function computeFilteredFeatures(networkGeo, volumeJSON, timeRange) {
        const startTick = timeRange?.[0] ?? 0;
        const endTick = timeRange?.[1] ?? 96;
        
        return networkGeo.features
        .filter((f) => volumeJSON.hasOwnProperty(f.properties.id.toString()))
        .map((f) => {
            const linkId = f.properties.id.toString();
            const lineVolumes = volumeJSON[linkId];
            
            let total = 0;
            let filtered = 0;
            
            for (const lineId in lineVolumes) {
                const { total: lineTotal, timeBins } = lineVolumes[lineId];
                total += lineTotal;
                
                for (let h = startTick; h < endTick; h++) {
                    const hour = Math.floor(h / 4).toString().padStart(2, '0');
                    const minute = ((h % 4) * 15).toString().padStart(2, '0');
                    const key = `${hour}:${minute}`;
                    filtered += timeBins[key] ?? 0;
                }
            }
            
            return {
                ...f,
                properties: {
                    ...f.properties,
                    total_volume: total,
                    filtered_volume: filtered,
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
        };
        
        const init = async () => {
            removeLayers();
            
            try {
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
                            0, 0.5,
                            5, 1,
                            10, 3,
                            50, 5,
                            100, 7
                        ]
                    }
                });

                if (selectedTransitModes && !selectedTransitModes.includes("all")) {
  map.setFilter("transit-volumes-layer", [
    "any",
    ...selectedTransitModes.map(mode => ["in", mode, ["get", "modes"]])
  ]);
}
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
    }, [selectedTransitModes]);
}
