import { useEffect, useRef, useState } from 'react';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

export default function useNetworkLayers({
  mapRef,
  searchCanton,
  dataURL,
  selectedNetworkModes,
  showMajorRoadsOnly,
  timeRange,
  visualizeLinkId,
  setSelectedNetworkFeature,
  isGraphExpanded,
  resetMapTrigger
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [linkVolumeData, setLinkVolumeData] = useState(null);
  const originalNetworkGeoJSON = useRef(null);

  const selectedNetworkModesRef = useRef(selectedNetworkModes);
  const graphExpandedRef = useRef(isGraphExpanded);

  const loadWithFallback = useLoadWithFallback(dataURL);

  // Keep refs up-to-date
  useEffect(() => {
    selectedNetworkModesRef.current = selectedNetworkModes;
  }, [selectedNetworkModes]);

  useEffect(() => {
    graphExpandedRef.current = isGraphExpanded;
  }, [isGraphExpanded]);


  // ─────────────────────────────────────────────────────────────────────────────
  // Load the network only if not already loaded and in correct module
  // ─────────────────────────────────────────────────────────────────────────────

  const loadNetworkForCanton = async (cantonName) => {
    const map = mapRef.current;
    if (!map) return;

    const layersToRemove = ["network-layer", "click-network-layer", "ant-line", "network-highlight"];
    const sourcesToRemove = ["network-source", "network-highlight", "ant-path"];

    layersToRemove.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    sourcesToRemove.forEach(id => {
      if (map.getSource(id)) map.removeSource(id);
    });

    setIsLoading(true);
    setSelectedNetworkFeature(null);

    const relativePath = `matsim/matsim_network_${cantonName}.geojson`;
    let networkGeojson;
        try {
          networkGeojson = await loadWithFallback(relativePath);
        } catch (error) {
          console.warn(`Failed to load network for ${cantonName}`, error);
          return;
        }
        
        if (!networkGeojson) return;

    originalNetworkGeoJSON.current = networkGeojson;

    map.addSource("network-source", { type: "geojson", data: networkGeojson });

    map.addLayer({
      id: "click-network-layer",
      type: "line",
      source: "network-source",
      paint: {
        "line-width": ["interpolate", ["linear"], ["get", "capacity"], 300, 7, 4000, 14],
        "line-opacity": 0,
      },
    });

    map.addLayer({
      id: "network-layer",
      type: "line",
      source: "network-source",
      paint: {
        "line-width": ["interpolate", ["linear"], ["get", "capacity"], 300, 1, 4000, 8],
        "line-color":
        graphExpandedRef.current === "Volumes"
        ? ["interpolate", ["linear"], ["get", "daily_avg_volume"],
        0, "#ffffcc",
        50, "#c2e699",
        100, "#78c679",
        250, "#31a354",
        500, "#006837"]
        : ["interpolate", ["linear"], ["get", "freespeed"],
        0, "#ffffb2",
        6.94, "#fed976",
        13.89, "#feb24c",
        20.83, "#fd8d3c",
        27.78, "#fc4e2a",
        34.72, "#e31a1c",
        41.67, "#b10026"]
      }
    });

            updateNetworkFilter(selectedNetworkModesRef.current);
        
        if (graphExpandedRef.current === "Volumes") {
          const carFilter = ["match", ["index-of", "car", ["get", "modes"]], -1, false, true];
          
          
          let filter = carFilter;
          
          if (showMajorRoadsOnly) {
            // combine both filters
            filter = ["all", carFilter, [">", ["get", "capacity"], 1000]];
          }
          
          map.setFilter("click-network-layer", filter);
          map.setFilter("network-layer", filter);
          
          if (map.getLayer("network-highlight")) {
            map.setFilter("network-highlight", filter);
          }
        }

            const handleIdle = () => {
          setIsLoading(false);
          map.off("idle", handleIdle);
        };
        map.on("idle", handleIdle);

map.on("click", "click-network-layer", (e) => {
          if (!e.features.length) return;
          
          if (map.getLayer("ant-line")) {
            map.removeLayer("ant-line");
          }
          
          ["network-highlight"].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
          });
          
          const feature_list = [e.features[0].properties];
          if (e.features[1]) feature_list.push(e.features[1].properties);
          
          const allFeatures = map.getSource("network-source")._data.features;
          const fullFeature = allFeatures.find(f => f.properties.id === feature_list[0].id);
          if (!fullFeature) return;
          
          const highlightGeoJSON = {
            type: "FeatureCollection",
            features: [fullFeature]
          };
          
          map.addSource("network-highlight", {
            type: "geojson",
            data: highlightGeoJSON
          });
          
          map.addLayer({
            id: "network-highlight",
            type: "line",
            source: "network-highlight",
            paint: {
              "line-width": ["interpolate", ["linear"], ["get", "capacity"], 300, 5, 4000, 14],
              "line-color": "#8affff",
              "line-opacity": 1
            }
          }, "network-layer");
          
          setSelectedNetworkFeature(feature_list);
        });
  };

  // --------- UPDATING NETWORK BY MODE ----------
      const updateNetworkFilter = (modes) => {
        if (!mapRef.current) return;
        const map = mapRef.current;
        
        if (!map.getLayer("network-layer")) return;
        
        // If "all" modes selected, remove filter
        if (!modes || modes.includes("all")) {
          map.setFilter("network-layer", null);
          map.setFilter("click-network-layer", null);
          if (map.getLayer("network-highlight")){
            map.setFilter("network-highlight", null);
          }
        } else {
          // set filter for roads that match ANY of the selected modes
          map.setFilter("network-layer", [
            "any",
            ...modes.map(mode => ["match", ["index-of", mode, ["get", "modes"]], -1, false, true])
          ]);
          map.setFilter("click-network-layer", [
            "any",
            ...modes.map(mode => ["match", ["index-of", mode, ["get", "modes"]], -1, false, true])
          ]);
          
          // if the highlight also exists, filter that too
          if (map.getLayer("network-highlight")){
            map.setFilter("network-highlight", [
              "any",
              ...modes.map(mode => ["match", ["index-of", mode, ["get", "modes"]], -1, false, true])
            ]);
          }
          
          // We don't need to filter the ant-path because it will not
          // appear on the same screen as the matsim filter screen
        }
      };

      // Update network mode filter (MatSIM Network) on change
      useEffect(() => {
        if (!mapRef.current) return;
        
        selectedNetworkModesRef.current = selectedNetworkModes;
        updateNetworkFilter(selectedNetworkModes); // Apply mode filter when it changes
      }, [selectedNetworkModes]);

      useEffect(() => {
        const map = mapRef.current;

        if (!map || graphExpandedRef.current !== "Volumes") return;
        
        const carFilter = ["match", ["index-of", "car", ["get", "modes"]], -1, false, true];
        const fullFilter =
          isGraphExpanded === "Volumes" && showMajorRoadsOnly
            ? ["all", carFilter, [">", ["get", "capacity"], 1000]]
            : carFilter;
        
        // If turning off the major roads filter, re-apply full network
        if (!showMajorRoadsOnly && originalNetworkGeoJSON) {
          const source = map.getSource("network-source");
          if (source) source.setData(originalNetworkGeoJSON.current);
        }
        
        if (map.getLayer("network-layer")) map.setFilter("network-layer", fullFilter);
        if (map.getLayer("click-network-layer")) map.setFilter("click-network-layer", fullFilter);
        if (map.getLayer("network-highlight")) map.setFilter("network-highlight", fullFilter);
      }, [showMajorRoadsOnly, isGraphExpanded, originalNetworkGeoJSON]);

  // ---------------- ADD ANT PATH TO VISUALIZE VOLUME DIRECTION ----------------
        useEffect(() => {
          if (!visualizeLinkId || !mapRef.current) return;
          
          const map = mapRef.current;
          const source = map.getSource("network-source");
          
          if (!source || !source._data) return;
          
          // Access full GeoJSON source
          const fullGeoJSON = source._data;
          const feature = fullGeoJSON.features.find(f => f.properties.id === visualizeLinkId);
          
          if (!feature) return;
          
          // convert MultiLineString into a LineString
          // if a line is discontinuous, it forces it to be continuous
          // ie: -----      ------- →  --------------------
          const mergedCoords =
          feature.geometry.type === "LineString"
          ? feature.geometry.coordinates
          : feature.geometry.type === "MultiLineString"
          ? feature.geometry.coordinates.flat()
          : [];
          
          if (mergedCoords.length < 2) return;
          
          // Remove existing layer/source
          if (map.getLayer("ant-line")) map.removeLayer("ant-line");
          if (map.getSource("ant-path")) map.removeSource("ant-path");
          
          // Add new source with a single LineString
          map.addSource("ant-path", {
            type: "geojson",
            data: {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: mergedCoords,
              },
              properties: {},
            },
          });
          
          map.addLayer({
            id: "ant-line",
            type: "line",
            source: "ant-path",
            layout: {},
            paint: {
              "line-color": "#FF00FF",
              "line-width": 4,
              "line-dasharray": [3, 3], // initial
            },
          });
          
          // Create dash animation sequence
          const dashArraySeq = [
            [0, 0.3, 3, 2.7],
            [0, 0.6, 3, 2.4],
            [0, 0.9, 3, 2.1],
            [0, 1.2, 3, 1.8],
            [0, 1.5, 3, 1.5],
            [0, 1.8, 3, 1.2],
            [0, 2.1, 3, 0.9],
            [0, 2.4, 3, 0.6],
            [0, 2.7, 3, 0.3],
            [0, 3.0, 3, 0],
            [0.3, 3, 2.7, 0],
            [0.6, 3, 2.4, 0],
            [0.9, 3, 2.1, 0],
            [1.2, 3, 1.8, 0],
            [1.5, 3, 1.5, 0],
            [1.8, 3, 1.2, 0],
            [2.1, 3, 0.9, 0],
            [2.4, 3, 0.6, 0],
            [2.7, 3, 0.3, 0],
            [3, 3, 0, 0],
          ];
          let dashArrayIdx = 0;
          let lastUpdateTime = 0;
          const frameIntervalMs = 50; // update every 50ms
          
          // Animate line as a "ant path", by constantly changing the dash-array sequence
          // to make it appear to "move"
          function animateLine(timestamp) {
            if (!map.getLayer("ant-line")) return;
            
            if (timestamp - lastUpdateTime >= frameIntervalMs) {
              dashArrayIdx = (dashArrayIdx + 1) % dashArraySeq.length;
              map.setPaintProperty("ant-line", "line-dasharray", dashArraySeq[dashArrayIdx]);
              lastUpdateTime = timestamp;
            }
            
            requestAnimationFrame(animateLine);
          }
          
          requestAnimationFrame(animateLine);
          
          return () => {
            if (map.getLayer("ant-line")) map.removeLayer("ant-line");
            if (map.getSource("ant-path")) map.removeSource("ant-path");
          };
        }, [visualizeLinkId]); // run when visualizeLinkId changes

        // handles switching between network / non-network modules on the sidebar
              useEffect(() => {
                const map = mapRef.current;
                const canton = searchCanton;
                
                if (!map || !canton) return;
                
                // Hides all network layers
                const hideNetworkLayers = () => {
                  ["network-layer", "click-network-layer", "network-highlight"].forEach(id => {
                    if (map.getLayer(id)) {
                      map.setLayoutProperty(id, "visibility", "none");
                    }
                  });
                };
                
                // Shows network layers
                const showNetworkLayers = () => {
                  ["network-layer", "click-network-layer", "network-highlight"].forEach(id => {
                    if (map.getLayer(id)) {
                      map.setLayoutProperty(id, "visibility", "visible");
                    }
                  });
                };
                
                if (isGraphExpanded === "Network" || isGraphExpanded === "Volumes") {
                  if (map.getLayer("network-layer")) {
                    showNetworkLayers(); 
                    if (isGraphExpanded === "Network") {
                      // reload full network
                      const source = map.getSource("network-source");
                      if (source) source.setData(originalNetworkGeoJSON.current);
                      map.setFilter("network-layer", null);
                      map.setFilter("click-network-layer", null);
                      if (map.getLayer("network-highlight")) {
                        map.setFilter("network-highlight", null);
                      }
                    } else if (isGraphExpanded === "Volumes") {
                      
                      if (!showMajorRoadsOnly) {
                        const source = map.getSource("network-source");
                        if (source) source.setData(originalNetworkGeoJSON.current);
                      }
                    }
                  } else {
                    loadNetworkForCanton(canton);
                  }
                } else {
                  hideNetworkLayers();
                }
                
                
                if (!map.getLayer("network-layer")) return;
                
                // Update line color based on selected module
                const colorRamp = isGraphExpanded === "Volumes"
                ? [
                  "interpolate", ["linear"], ["get", "daily_avg_volume"],
                  0, "#ffffcc",
                  50, "#c2e699",
                  100, "#78c679",
                  250, "#31a354",
                  500, "#006837"
                ]
                : [
                  "interpolate", ["linear"], ["get", "freespeed"],
                  0, "#ffffb2",
                  6.94, "#fed976",
                  13.89, "#feb24c",
                  20.83, "#fd8d3c",
                  27.78, "#fc4e2a",
                  34.72, "#e31a1c",
                  41.67, "#b10026"
                ];
                
                map.setPaintProperty("network-layer", "line-color", colorRamp);
                
                if (map.getLayer("ant-line")) {
                  map.removeLayer("ant-line");
                }
                
                // Handles maintaining highlight when swapping between network / volumes
                if (map.getSource("network-highlight")) {
                  const source = map.getSource("network-highlight");
                  
                  // check if the highlight contains mode "car" from its source
                  let hasCarMode = false;
                  
                  if (source && source._data) {
                    const features = source._data.features;
                    
                    hasCarMode = features.some(f => {
                      const modes = f.properties?.modes;
                      return modes?.split(",").includes("car");
                    });
                  }
                  
                  // if not a car, remove it
                  if (!hasCarMode) {
                    setSelectedNetworkFeature(null);
                    
                    // if its not a car + we swap back to network, retrieve the
                    // segment properties from "network-highlight" source
                    if (isGraphExpanded === "Network"){
                      setSelectedNetworkFeature([source._data.features[0].properties]);
                    }
                  }
                }
                
              }, [isGraphExpanded]);
              
              // Visualize link volume data based on time range -------------------------
              
              // load link volume data for current canton
              useEffect(() => {
                
                const loadAllLinkVolumes = async () => {
                  if (!searchCanton || graphExpandedRef.current !== "Volumes") return;
                  
                  try {
                    const path = `matsim/${searchCanton}_link_traffic_volumes.json`;
                    const raw = await loadWithFallback(path);
                    
                    const volumeMap = Object.fromEntries(
                      raw.map(e => [e.link_id.toString(), e.hourly_avg_volumes])
                    );
                    setLinkVolumeData(volumeMap);
                  } catch (err) {
                    console.warn("Failed to load all link volumes", err);
                  }
                };
                
                loadAllLinkVolumes();
              }, [searchCanton, isGraphExpanded]);
              
              useEffect(() => {
                if (!mapRef.current || !linkVolumeData || graphExpandedRef.current !== "Volumes") return;
                
                const map1 = mapRef.current;
                const source = map1.getSource("network-source");
                if (!source || !source._data) return;
                
                const startHour = Math.floor((timeRange[0] ?? 0) / 4);
                const endHour = Math.ceil((timeRange[1] ?? 96) / 4);
                
                const relevantFeatures = showMajorRoadsOnly
                ? source._data.features.filter(f => f.properties.capacity > 1000)
                : source._data.features;
                
                const updatedFeatures = relevantFeatures.map(f => {
                  const id = f.properties.id.toString();
                  const capacity = f.properties.capacity ?? 0;
                  
                  // Skip recalculation for low-capacity roads if filter is active
                  if (showMajorRoadsOnly && capacity <= 1000) return f;
                  
                  const hourly = linkVolumeData[id];
                  let total = 0;
                  
                  if (hourly) {
                    for (let h = startHour; h < endHour; h++) {
                      const key = `HRS${h}-${h + 1}avg`;
                      total += hourly[key] ?? 0;
                    }
                  }
                  
                  return {
                    ...f,
                    properties: {
                      ...f.properties,
                      daily_avg_volume: total
                    }
                  };
                });
                
                
                const updatedGeoJSON = {
                  ...source._data,
                  features: updatedFeatures
                };
                
                source.setData(updatedGeoJSON);
              }, [timeRange, linkVolumeData, isGraphExpanded, showMajorRoadsOnly]);


              // add this to reload network when canton changes
                    useEffect(() => {
                      const map = mapRef.current;
                      if (searchCanton && map) {
                          
                          if (graphExpandedRef.current === "Network" || graphExpandedRef.current === "Volumes") {
                            loadNetworkForCanton(searchCanton);
                          } else {
                            // Remove network-related layers and sources
                            if (map.getLayer("network-layer")) {
                              map.removeLayer("network-layer");
                              map.removeLayer("click-network-layer");
                              map.removeSource("network-source");
                            }
                            if (map.getLayer("ant-line")) {
                              map.removeLayer("ant-line");
                              map.removeSource("ant-path")
                            }
                            ["network-highlight"].forEach(id => {
                              if (map.getLayer(id)) map.removeLayer(id);
                              if (map.getSource(id)) map.removeSource(id);
                            });
                          }
                        }
                      }, [searchCanton]); // only update when searchCanton updates

                      useEffect(() => {
  if (!mapRef.current) return;

  // Remove all network layers and sources
  const map = mapRef.current;

  const layersToRemove = [
    "network-layer", "click-network-layer", "ant-line", "network-highlight"
  ];
  const sourcesToRemove = [
    "network-source", "ant-path", "network-highlight"
  ];

  layersToRemove.forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
  });

  sourcesToRemove.forEach(id => {
    if (map.getSource(id)) map.removeSource(id);
  });

  // Reset internal state if needed
  originalNetworkGeoJSON.current = null;
  setLinkVolumeData(null);
  setSelectedNetworkFeature(null);
}, [resetMapTrigger]);
                      
                      
  return { isLoading };
}
