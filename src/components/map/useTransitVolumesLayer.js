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
        const endTick   = timeRange?.[1] ?? 96;
        const isFullDay = startTick === 0 && endTick === 96;
        
        const mergeLineBins = (dst, src) => {
            // src: { timeBins: { "HH:MM": number }, ... }
            if (!src?.timeBins) return;
            const tb = src.timeBins;
            for (const t in tb) {
                dst[t] = (dst[t] ?? 0) + (tb[t] ?? 0);
            }
        };
        
        const mergeLines = (acc, linesObj) => {
            // acc: { [lineId]: { timeBins: {...} } }
            for (const lineId in linesObj) {
                if (!acc[lineId]) acc[lineId] = { timeBins: {} };
                mergeLineBins(acc[lineId].timeBins ? acc[lineId] : acc[lineId], linesObj[lineId]);
            }
        };
        
        const unionModes = (acc, modes) => {
            if (Array.isArray(modes)) modes.forEach(m => acc.add(String(m)));
            else if (typeof modes === 'string') modes.split(',').forEach(m => acc.add(m.trim()));
        };
        
        const features = [];
        
        for (const f of networkGeo.features) {
            // normalize per_id
            let perId = f?.properties?.per_id ?? {};
            if (typeof perId === 'string') {
                try { perId = JSON.parse(perId); } catch { perId = {}; }
            }
            const perIds = Object.keys(perId);
            if (perIds.length === 0) continue;
            
            // keep only ids that exist in the volume json
            const matchedIds = perIds.filter(id => Object.prototype.hasOwnProperty.call(volumeJSON, String(id)));
            if (matchedIds.length === 0) continue;
            
            // aggregate across matched ids
            let total = 0;
            let filtered = 0;
            const mergedLines = {};                // { lineId: { timeBins: { 'HH:MM': sum } } }
            const modesUnion = new Set();
            
            for (const id of matchedIds) {
                const entry = volumeJSON[String(id)];
                if (!entry) continue;
                total += Number(entry.linkTotal ?? 0);
                
                // merge lines and modes
                if (entry.lines) mergeLines(mergedLines, entry.lines);
                unionModes(modesUnion, entry.modes_list);
                
                if (!isFullDay) {
                    // sum window across all lines' timeBins
                    for (const lineId in entry.lines || {}) {
                        const tb = entry.lines[lineId]?.timeBins || {};
                        for (let tick = startTick; tick < endTick; tick++) {
                            const hour = String(Math.floor(tick / 4)).padStart(2, '0');
                            const minute = String((tick % 4) * 15).padStart(2, '0');
                            const key = `${hour}:${minute}`;
                            filtered += tb[key] ?? 0;
                        }
                    }
                }
            }
            if (isFullDay) filtered = total;
            
            // Build updated feature (shallow clone props)
            features.push({
                ...f,
                properties: {
                    ...f.properties,
                    total_volume: total,
                    filtered_volume: filtered,
                    // prefer link-level from merged network if present; keep fallbacks
                    length: typeof f.properties.length === 'number'
                    ? f.properties.length
                    : undefined,
                    freespeed: typeof f.properties.freespeed === 'number'
                    ? f.properties.freespeed
                    : undefined,
                    modes: Array.from(modesUnion),   // array for ["in", mode, ["get","modes"]]
                    lines: mergedLines,
                    line_ids: Object.keys(mergedLines),
                    link_ids: matchedIds,           // ← which per-ids contributed
                    link_key_join: matchedIds.sort().join(','), // ← stable key for highlight refresh
                },
            });
        }
        
        return features;
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
                
                const networkPath = `matsim/${searchCanton}_merged_segments.geojson`;
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
                    
                    // You usually click exactly one merged feature
                    const clickedKeys = new Set(
                        e.features
                        .map(f => f?.properties?.link_key_join)
                        .filter(Boolean)
                    );
                    
                    const allFeatures = map.getSource("transit-volumes-source")._data.features || [];
                    const fullFeatures = clickedKeys.size
                    ? allFeatures.filter(f => clickedKeys.has(f?.properties?.link_key_join))
                    : e.features; // fallback: take what Mapbox returned
                    
                    if (!fullFeatures.length) return;
                    
                    // Remove previous highlight + ant
                    if (map.getLayer("transit-volumes-highlight")) map.removeLayer("transit-volumes-highlight");
                    if (map.getSource("transit-volumes-highlight")) map.removeSource("transit-volumes-highlight");
                    if (map.getLayer("ant-line")) map.removeLayer("ant-line");
                    if (map.getSource("ant-path")) map.removeSource("ant-path");
                    
                    // Highlight
                    map.addSource("transit-volumes-highlight", {
                        type: "geojson",
                        data: { type: "FeatureCollection", features: fullFeatures }
                    });
                    
                    const insertBelow = map.getLayer("transit-symbology-line")
                    ? "transit-symbology-line"
                    : "transit-volumes-layer";
                    
                    map.addLayer({
                        id: "transit-volumes-highlight",
                        type: "line",
                        source: "transit-volumes-highlight",
                        paint: {
                            "line-width": [
                                "interpolate", ["linear"], ["get", "filtered_volume"],
                                0, 8, 5, 10, 10, 12, 50, 14, 100, 16
                            ],
                            "line-color": "#00ffff"
                        }
                    }, insertBelow);
                    
                    // Sidebar: pass properties array
                    setSelectedTransitLink(fullFeatures.map(f => f.properties));
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
            const prevHighlight = highlightSource._data?.features || [];
            const prevKeys = new Set(
                prevHighlight.map(f => f?.properties?.link_key_join).filter(Boolean)
            );
            
            const updatedHighlight = updatedFeatures.filter(
                f => prevKeys.has(f?.properties?.link_key_join)
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
