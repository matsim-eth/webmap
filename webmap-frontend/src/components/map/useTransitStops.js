import { useEffect } from "react";

export default function useTransitStops({
  mapRef,
  searchCanton,
  isGraphExpanded,
  loadWithFallback,
  showStopVolumeSymbology,
  selectedTransitModes,
  setSelectedTransitStop,
  setHighlightedLineId,
  setHighlightedRouteIds,
  highlightedLineId,
  suppressNextSearchZoom,
  setFeatureGeoJSON,
  timeRange,
  selectedDirection,
  drawRef
}) {
  
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    
    // remove current transit layers and sources
    const removeTransitLayers = () => {
      ["transit-stops-layer", "transit-stops-label", "transit-highlight-layer", "transit-stops-hitbox"].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      
      ["transit-stops", "transit-highlight"].forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
      });
      
      // Clear transit-line-display if in Transit mode (used for transit route display)
      if (isGraphExpanded === "Transit" && map.getSource("transit-line-display")) {
        map.getSource("transit-line-display").setData({ type: "FeatureCollection", features: [] });
      }
      
      setSelectedTransitStop(null);
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);
    };
    
    // if swapped off Transit module, remove layers
    if (isGraphExpanded !== "Transit" || !searchCanton) {
      removeTransitLayers();
      // Don't null featureGeoJSON here — whoever owns the current value
      // (network modules set it in useNetworkLayers, transit volumes sets it
      // in useTransitVolumesLayer) is responsible for replacing it on entry.
      // Nulling indiscriminately was breaking network-ref readers (VolumeFlow /
      // NodeFlows / LinkSpeeds) after any detour through Choropleth, PtBoardings,
      // or Destination modules.
      return;
    }
    
    // data loading...
    const stopsPath = `matsim/transit/stops_by_canton/${searchCanton}_stops.geojson`;
    const volumePath = `matsim/transit/per_canton_counts/${searchCanton}_counts.json`;
    
    Promise.all([
      loadWithFallback(stopsPath),
      loadWithFallback(volumePath)
    ])
    .then(([geojson, volumeData]) => {
      let updatedGeoJSON = geojson;
      
      // === Aggregate volume data by stop_id ===
      const volumeByStopId = {};
      const detailedVolumeByStopId = {};
      
      // Helper to convert time bin "HH:MM" to tick index (0-95)
      const timeBinToTick = (timeBin) => {
        const [h, m] = timeBin.split(':').map(Number);
        return h * 4 + Math.floor(m / 15);
      };
      
      const startTick = timeRange?.[0] ?? 0;
      const endTick = timeRange?.[1] ?? 96;
      
      if (volumeData) {
        volumeData.forEach(entry => {
          const stopId = entry.stop_id;
          if (!volumeByStopId[stopId]) {
            volumeByStopId[stopId] = 0;
            detailedVolumeByStopId[stopId] = { boardings: 0, alightings: 0 };
          }
          entry.data.forEach(dp => {
            // Filter by time range
            const tick = timeBinToTick(dp.time_bin);
            if (tick < startTick || tick >= endTick) return;
            
            const boardings = dp.boardings || 0;
            const alightings = dp.alightings || 0;
            volumeByStopId[stopId] += boardings + alightings;
            detailedVolumeByStopId[stopId].boardings += boardings;
            detailedVolumeByStopId[stopId].alightings += alightings;
          });
        });
      }
      
      // === Inject volume and line_ids into stop features ===
      updatedGeoJSON = {
        ...geojson,
        features: geojson.features.map((f, i) => {
          const rawStopId = f.properties.stop_id;
          const ids = Array.isArray(rawStopId)
          ? rawStopId
          : String(rawStopId).split(",").map(id => id.trim()).filter(Boolean);
          
          // Aggregate volume across all stop IDs
          let totalVolume = 0;
          let totalBoardings = 0;
          let totalAlightings = 0;
          
          ids.forEach(id => {
            totalVolume += volumeByStopId[id] || 0;
            const detailed = detailedVolumeByStopId[id];
            if (detailed) {
              totalBoardings += detailed.boardings;
              totalAlightings += detailed.alightings;
            }
          });
          
          // lines is already an array of objects in the GeoJSON
          const lines = f.properties.lines || [];
          // Extract unique line_ids
          const lineIds = Array.isArray(lines)
            ? [...new Set(lines.map(l => l.line_id).filter(Boolean))]
            : [];

          // Direction-filtered line_ids: only include line_ids served by
          // routes matching the selected direction (H=outbound, R=return)
          const dir = selectedDirection || 'total';
          let directionLineIds;
          if (dir !== 'total') {
            const suffix = dir === 'outbound' ? '.H' : '.R';
            directionLineIds = [...new Set(
              lines
                .filter(l => l.route_id && l.route_id.endsWith(suffix))
                .map(l => l.line_id)
            )];
          } else {
            directionLineIds = lineIds;
          }
          
          // Create searchable text for "All columns" search (lowercase, pipe-delimited)
          const stopName = f.properties.name || "";
          const modes = Array.isArray(f.properties.modes_list) 
            ? f.properties.modes_list.join(", ") 
            : String(f.properties.modes_list || "");
          const searchableText = [
            stopName.toLowerCase(),
            modes.toLowerCase(),
            String(lineIds.length),
            String(totalBoardings),
            String(totalAlightings)
          ].join('|');
          
          return {
            ...f,
            id: i,
            properties: {
              ...f.properties,
              volume: totalVolume,
              boardings: totalBoardings,
              alightings: totalAlightings,
              line_ids: lineIds,
              direction_line_ids: directionLineIds,
              searchable_text: searchableText
            }
          };
        })
      };
      
      // Export the GeoJSON for the feature table
      if (setFeatureGeoJSON) {
        setFeatureGeoJSON(updatedGeoJSON);
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
        // if layer already exists, update radius only (ie. if symbology toggle changed)
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
      
      // change size of highlight layer on volume size toggle (if exists)
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
    
    // add transit stop label (names of stops if zoomed in enough)
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
    
    // increases radius of clickable area around stops
    if (!map.getLayer("transit-stops-hitbox")) {
      map.addLayer({
        id: "transit-stops-hitbox",
        type: "circle",
        source: "transit-stops",
        paint: {
          // Use safe fallback when volume is missing
          "circle-radius": [
            "interpolate", ["linear"], ["to-number", ["get", "volume"], 0],
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

      // Skip stop selection when actively drawing, editing vertices,
      // or clicking on a drawn polygon (includes double-click to finish)
      if (drawRef?.current) {
        const mode = drawRef.current.getMode();
        if (mode === 'draw_polygon' || mode === 'direct_select') return;
        const clickedLayers = map.queryRenderedFeatures(e.point).map(fl => fl.layer.id);
        if (clickedLayers.some(id => id.startsWith('gl-draw'))) return;
      }

      // Clear any drawn polygons first — delete fires draw.delete which
      // resets polygon fading and clears polygonSelection, then the stop
      // selection below overwrites the cleared selectedTransitStop.
      if (drawRef?.current?.getAll?.()?.features?.length > 0) {
        drawRef.current.deleteAll();
        map.fire('draw.delete', { features: [] });
      }

      const f = features[0];
      const combinedLines = JSON.parse(f.properties.lines);
      const combinedModes = JSON.parse(f.properties.modes_list);
      
      console.log(f)

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
      
      // get current line-id from layer (using transit-line-display for transit routes)
      if (map.getSource("transit-line-display")) {
        const currentData = map.getSource("transit-line-display")._data;
        const currentFeature = currentData?.features?.[0];
        currentHighlightedLineId = currentFeature?.properties?.line_id;
      }
      
      // if selected stop is on the current highlighted line, keep it the line visible / selected
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
        // if not, reset highlighted transit line (clear transit-line-display when not keeping line)
        if (map.getSource("transit-line-display")) {
          map.getSource("transit-line-display").setData({ type: "FeatureCollection", features: [] });
        }
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
      
      // add highlight layer for clicked stop
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
      
      // push stop attributes to sidebar
      setSelectedTransitStop({
        name,
        stop_id,
        stop_ids: allStopIds,
        lines: combinedLines,
        modes_list: combinedModes
      });
    });
    
    // === apply mode filtering ===
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
    
    // Skip opacity reset if polygon fading is active (hook will re-apply)
    const hasPolygons = drawRef?.current?.getAll?.()?.features?.length > 0;
    if (!hasPolygons) {
      map.setPaintProperty("transit-stops-layer", "circle-opacity", 1);
      map.setPaintProperty("transit-stops-layer", "circle-stroke-opacity", 1.0);
      map.setPaintProperty("transit-stops-label", "text-opacity", 1.0);
    }

    // If this canton load was triggered by an inter-cantonal stop click and a line is selected,
    // apply CASE-based opacity so only stops on that line are fully opaque.
    console.log("suppressNextSearchZoom:", suppressNextSearchZoom?.current, "highlightedLineId:", highlightedLineId);
    if (suppressNextSearchZoom?.current && highlightedLineId) {

      const hasLineHere = (updatedGeoJSON.features || []).some(
        (f) => Array.isArray(f.properties.line_ids) && f.properties.line_ids.includes(highlightedLineId)
      );
      if (hasLineHere) {
        const applyMask = () => {
          const lineIdsProp = (selectedDirection && selectedDirection !== 'total') ? "direction_line_ids" : "line_ids";
          const matchLineExpr = ["in", highlightedLineId, ["get", lineIdsProp]];
          if (map.getLayer("transit-stops-layer")) {
            map.setPaintProperty("transit-stops-layer", "circle-opacity", ["case", matchLineExpr, 1, 0.2]);
            map.setPaintProperty("transit-stops-layer", "circle-stroke-opacity", ["case", matchLineExpr, 1.0, 0.2]);
          }
          if (map.getLayer("transit-stops-label")) {
            map.setPaintProperty("transit-stops-label", "text-opacity", ["case", matchLineExpr, 1.0, 0.2]);
          }
        };
        map.once("idle", applyMask);
        setTimeout(applyMask, 500);
      }
      // Clear flag so normal canton selections do not mask
      suppressNextSearchZoom.current = false;
    }
  })
  .catch(err => {
    console.error("Error loading transit data:", err);
  });
}, [isGraphExpanded, searchCanton, showStopVolumeSymbology, selectedTransitModes, timeRange, selectedDirection]);


useEffect(() => {
  const map = mapRef.current;
  if (!map || isGraphExpanded !== "Transit") return;
  
  const STOP_LAYER_ID = "transit-stops-layer";
  const LABEL_LAYER_ID = "transit-stops-label";
  
  function updateStopMask() {
    if (!map.getLayer(STOP_LAYER_ID) || !map.getLayer(LABEL_LAYER_ID)) return;

    if (highlightedLineId) {
      const lineIdsProp = (selectedDirection && selectedDirection !== 'total') ? "direction_line_ids" : "line_ids";
      const matchLineExpr = ["in", highlightedLineId, ["get", lineIdsProp]];
      
      map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", [
        "case",
        matchLineExpr,
        1,
        0.2,
      ]);
      
      map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", [
        "case",
        matchLineExpr,
        1.0,
        0.2,
      ]);
      
      map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", [
        "case",
        matchLineExpr,
        1.0,
        0.2,
      ]);
    } else {
      // Re-apply polygon fading if polygons are drawn, otherwise reset to full opacity
      const hasPolygons = drawRef?.current?.getAll?.()?.features?.length > 0;
      if (hasPolygons) {
        const polyFade = ['case', ['boolean', ['feature-state', 'inPolygon'], false], 1, 0.2];
        map.setPaintProperty(STOP_LAYER_ID, 'circle-opacity', polyFade);
        map.setPaintProperty(STOP_LAYER_ID, 'circle-stroke-opacity', polyFade);
        map.setPaintProperty(LABEL_LAYER_ID, 'text-opacity', polyFade);
      } else {
        map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", 1);
        map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", 1.0);
        map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", 1.0);
      }
    }
  }
  
  updateStopMask();
  map.once("idle", updateStopMask);
  
  return () => {
    map.off("idle", updateStopMask);
  };
}, [mapRef, isGraphExpanded, highlightedLineId, selectedDirection]);
}
