import { useEffect, useRef } from "react";
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { lineServesDirection } from '../../utils/directionUtils';

const STOP_LAYER_ID = "transit-stops-layer";
const LABEL_LAYER_ID = "transit-stops-label";
const HITBOX_LAYER_ID = "transit-stops-hitbox";

// Map teardown only — no selection state is touched, so callers that need to
// preserve a line highlight across a canton switch (the inter-cantonal stop
// click) can use this without clobbering it.
const clearStopLayers = (map) => {
  safeRemoveLayer(map, [STOP_LAYER_ID, LABEL_LAYER_ID, "transit-highlight-layer", HITBOX_LAYER_ID]);
  safeRemoveSource(map, ["transit-stops", "transit-highlight"]);
};

// Dim every stop that the highlighted line does not serve. The direction toggle
// only switches which membership property is matched — both are injected up front.
const applyLineMask = (map, lineId, direction) => {
  const lineIdsProp = direction === 'outbound' ? "line_ids_h"
    : direction === 'return' ? "line_ids_r" : "line_ids";
  const matchLineExpr = ["in", lineId, ["get", lineIdsProp]];
  if (map.getLayer(STOP_LAYER_ID)) {
    map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", ["case", matchLineExpr, 1, 0.2]);
    map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", ["case", matchLineExpr, 1.0, 0.2]);
  }
  if (map.getLayer(LABEL_LAYER_ID)) {
    map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", ["case", matchLineExpr, 1.0, 0.2]);
  }
};

export default function useTransitStops({
  mapRef,
  searchCanton,
  datasetId,
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
  // Canton whose stops are currently painted into `transit-stops`. Distinguishes
  // a real canton switch (drop the old canton's features) from a re-run for a
  // symbology/mode/time change (keep them — the source is about to be updated
  // in place and blanking it would flash the map).
  const paintedCantonRef = useRef(null);
  const prevModuleRef = useRef(isGraphExpanded);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // remove current transit layers and sources
    const removeTransitLayers = () => {
      clearStopLayers(map);

      // Clear transit-line-display if in Transit mode (used for transit route display)
      if (isGraphExpanded === "Transit" && map.getSource("transit-line-display")) {
        map.getSource("transit-line-display").setData({ type: "FeatureCollection", features: [] });
      }

      setSelectedTransitStop(null);
    };

    // if swapped off Transit module, remove layers
    if (isGraphExpanded !== "Transit" || !searchCanton) {
      removeTransitLayers();
      // Only clear line highlight when actually leaving Transit, not on every
      // re-run while in a non-Transit module (e.g. timeRange changes in
      // TransitVolumes would otherwise deselect the highlighted line).
      if (prevModuleRef.current === "Transit" && isGraphExpanded !== "Transit") {
        setHighlightedLineId(null);
        setHighlightedRouteIds([]);
      }
      prevModuleRef.current = isGraphExpanded;
      // Don't null featureGeoJSON here — whoever owns the current value
      // (network modules set it in useNetworkLayers, transit volumes sets it
      // in useTransitVolumesLayer) is responsible for replacing it on entry.
      // Nulling indiscriminately was breaking network-ref readers (VolumeFlow /
      // NodeFlows / LinkSpeeds) after any detour through Choropleth, PtBoardings,
      // or Destination modules.
      paintedCantonRef.current = null;
      return;
    }
    prevModuleRef.current = isGraphExpanded;

    // A cold stops build can take tens of seconds, so a canton switch normally
    // leaves the previous canton's stops on the map (and in the feature table)
    // for the whole wait. Drop them up front: an empty map while loading is
    // honest, stale stops are not.
    if (paintedCantonRef.current !== null && paintedCantonRef.current !== searchCanton) {
      clearStopLayers(map);
      paintedCantonRef.current = null;
      setSelectedTransitStop(null);
      // An inter-cantonal stop click switches canton *in order to* follow the
      // highlighted line, so its highlight must survive this teardown.
      if (!suppressNextSearchZoom?.current) {
        setHighlightedLineId(null);
        setHighlightedRouteIds([]);
      }
    }
    
    // === Handle click ===
    // Bound once per effect run and removed in the cleanup below. This used
    // to live inside the .then(), where nothing ever removed it: every canton
    // switch, mode-filter change and time-slider drag added another handler,
    // so a single click eventually ran N of them, each closing over the state
    // of the run that created it — and the most stale one wrote last.
    // Binding before the layer exists is safe: mapbox-gl filters a delegated
    // listener's targets through getLayer() at event time.
    const handleStopClick = (e) => {
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
      // Mapbox stringifies non-scalar properties; guard the parses so one
      // malformed feature can't make every stop in the canton unclickable.
      const parseList = (raw) => {
        try { return JSON.parse(raw || '[]'); } catch { return []; }
      };
      const combinedLines = parseList(f.properties.lines);
      const combinedModes = parseList(f.properties.modes_list);

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
      safeRemoveLayer(map, "transit-highlight-layer");
      safeRemoveSource(map, "transit-highlight");
      
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
    };
    map.on("click", HITBOX_LAYER_ID, handleStopClick);

    // data loading...
    const stopsPath = `matsim/transit/stops_by_canton/${encodeURIComponent(searchCanton)}_stops.geojson`;
    const volumePath = `matsim/transit/per_canton_counts/${encodeURIComponent(searchCanton)}_counts.json`;
    
    // Discards the result of a load whose canton is no longer selected. Without
    // this the *slower* load won: switching from a cold canton to a warm one
    // painted the warm one first, then the cold one's response overwrote it, so
    // the map settled on the canton the user had already left.
    let cancelled = false;
    const controller = new AbortController();

    Promise.all([
      loadWithFallback(stopsPath, { signal: controller.signal }),
      loadWithFallback(volumePath, { signal: controller.signal })
    ])
    .then(([geojson, volumeData]) => {
      if (cancelled) return;
      // null comes back when a 401 refresh failed and we are redirecting to
      // login; there is nothing to paint and .features would throw.
      if (!geojson?.features) return;

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

          // Per-direction line membership (H=outbound, R=return), computed for
          // BOTH directions up front so a direction toggle needs no refetch —
          // the mask effect just switches which property it matches against.
          // lineServesDirection prefers the v2 `dirs` array (from the
          // pt_link_volumes table); entries with no direction info stay in both.
          const lineIdsH = [...new Set(
            lines.filter(l => lineServesDirection(l, 'outbound')).map(l => l.line_id)
          )];
          const lineIdsR = [...new Set(
            lines.filter(l => lineServesDirection(l, 'return')).map(l => l.line_id)
          )];
          
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
              line_ids_h: lineIdsH,
              line_ids_r: lineIdsR,
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
    
    setFilter(map, ["transit-stops-layer", "transit-highlight-layer", "transit-stops-label", "transit-stops-hitbox"], modeFilter);
    
    // Skip opacity reset if polygon fading is active (hook will re-apply)
    const hasPolygons = drawRef?.current?.getAll?.()?.features?.length > 0;
    if (!hasPolygons) {
      // A line highlight outlives a re-run of this effect (stop-volume toggle,
      // mode filter, time range), so re-apply its mask instead of blanket
      // resetting — the reset un-dimmed every stop in the canton, which read as
      // the line having been de-selected. The mask effect below can't repair it:
      // this effect resolves asynchronously, so it lands last.
      if (highlightedLineId) {
        applyLineMask(map, highlightedLineId, selectedDirection);
      } else {
        map.setPaintProperty(STOP_LAYER_ID, "circle-opacity", 1);
        map.setPaintProperty(STOP_LAYER_ID, "circle-stroke-opacity", 1.0);
        map.setPaintProperty(LABEL_LAYER_ID, "text-opacity", 1.0);
      }
    }

    // If this canton load was triggered by an inter-cantonal stop click and a line is selected,
    // apply CASE-based opacity so only stops on that line are fully opaque.
    if (suppressNextSearchZoom?.current && highlightedLineId) {

      const hasLineHere = (updatedGeoJSON.features || []).some(
        (f) => Array.isArray(f.properties.line_ids) && f.properties.line_ids.includes(highlightedLineId)
      );
      if (hasLineHere) {
        const applyMask = () => applyLineMask(map, highlightedLineId, selectedDirection);
        map.once("idle", applyMask);
        setTimeout(applyMask, 500);
      }
      // Clear flag so normal canton selections do not mask
      suppressNextSearchZoom.current = false;
    }

    paintedCantonRef.current = searchCanton;
  })
  .catch(err => {
    // A cancelled load is the expected outcome of switching canton mid-fetch,
    // not an error worth reporting.
    if (cancelled || err?.name === "AbortError") return;
    console.error("Error loading transit data:", err);
  });

  return () => {
    cancelled = true;
    controller.abort();
    map.off("click", HITBOX_LAYER_ID, handleStopClick);
  };
// NOTE: selectedDirection is deliberately NOT a dep — both directions' line
// memberships are injected up front, so a direction toggle needs no refetch.
// (Re-running here also raced the mask effect: this effect's trailing
// opacity reset wiped the just-applied direction mask, which read as the
// line being de-selected.)
}, [isGraphExpanded, searchCanton, datasetId, showStopVolumeSymbology, selectedTransitModes, timeRange]);


useEffect(() => {
  const map = mapRef.current;
  if (!map || isGraphExpanded !== "Transit") return;
  
  function updateStopMask() {
    if (!map.getLayer(STOP_LAYER_ID) || !map.getLayer(LABEL_LAYER_ID)) return;

    if (highlightedLineId) {
      applyLineMask(map, highlightedLineId, selectedDirection);
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
