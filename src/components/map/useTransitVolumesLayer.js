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
  highlightedLineId,
}) {
  const originalGeoJSON = useRef(null);
  
  // ----- helpers -------------------------------------------------------------
  
  // JS mirror of your Python clean_link_id
  function cleanLinkId(id) {
    const parts = String(id).split("_");
    const cleaned = parts.map((p) => p.split(":")[0]);
    return cleaned.join("_");
  }
  
  // If volume JSON is an array, index it by link_id and PRESERVE line_name/mode.
  function toVolumeById(vol) {
    if (!Array.isArray(vol)) return vol || {};
    
    const byId = Object.create(null);
    
    for (const e of vol) {
      if (!e) continue;
      
      const lid = String(e.link_id);
      const linesArr = Array.isArray(e.lines) ? e.lines : [];
      const linesObj = {};
      let linkTotal = 0;
      
      for (const l of linesArr) {
        const bins = l?.hourly_avg_volumes || {};
        const total = Object.values(bins).reduce((a, v) => a + (Number(v) || 0), 0);
        
        linesObj[String(l.line_id)] = {
          timeBins: { ...bins },
          line_name: l.line_name ?? null,
          mode: l.mode ?? null,
          total
        };
        
        linkTotal += total;
      }
      
      byId[lid] = {
        modes_list: e.modes_list || [],
        lines: linesObj,
        linkTotal
      };
    }
    
    return byId;
  }
  
  function tickKey(tick) {
    const h = Math.floor(tick / 4);
    const m = (tick % 4) * 15;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  
  const linesToObject = (entry) => {
    const out = {};
    if (Array.isArray(entry?.lines)) {
      for (const l of entry.lines) {
        const bins = l?.hourly_avg_volumes || {};
        out[String(l.line_id)] = {
          timeBins: bins,
          line_name: l.line_name ?? null,
          mode: l.mode ?? null,
          total: Object.values(bins).reduce((a, v) => a + (Number(v) || 0), 0),
        };
      }
    } else {
      for (const [lineId, line] of Object.entries(entry?.lines || {})) {
        const bins = line?.timeBins || {};
        out[String(lineId)] = {
          timeBins: bins,
          line_name: line.line_name ?? line.lineName ?? line.name ?? null,
          mode: line.mode ?? null,
          total: Number(line.total) || Object.values(bins).reduce((a, v) => a + (Number(v) || 0), 0),
        };
      }
    }
    return out;
  };
  
  // merge { [lineId]: { timeBins, line_name, mode, total } } into accumulator
  const mergeLines = (acc, src) => {
    for (const [lineId, line] of Object.entries(src || {})) {
      if (!acc[lineId]) {
        acc[lineId] = { timeBins: {}, line_name: line.line_name ?? null, mode: line.mode ?? null, total: 0 };
      }
      // keep name/mode if missing
      if (!acc[lineId].line_name && line.line_name) acc[lineId].line_name = line.line_name;
      if (!acc[lineId].mode && line.mode) acc[lineId].mode = line.mode;
      
      // merge totals
      acc[lineId].total += Number(line.total) || 0;
      
      // merge bins
      const dstBins = acc[lineId].timeBins;
      const srcBins = line.timeBins || {};
      for (const k in srcBins) dstBins[k] = (dstBins[k] ?? 0) + (Number(srcBins[k]) || 0);
    }
  };
  
  const unionModes = (acc, modes) => {
    if (Array.isArray(modes)) modes.forEach((m) => acc.add(String(m)));
    else if (typeof modes === "string")
      modes.split(",").forEach((m) => m && acc.add(m.trim()));
  };
  
  // NEW: compute left/right like roads, and also keep your filtered_volume
  function computeFilteredFeatures(networkGeo, rawVolumeJSON, timeRange, filterLineId) {
    const volumeJSON = toVolumeById(rawVolumeJSON);
    
    const startTick = timeRange?.[0] ?? 0;
    const endTick = timeRange?.[1] ?? 96;
    const isFullDay = startTick === 0 && endTick === 96;
    
    const features = [];
    
    for (const f of networkGeo.features) {
      // Parse pipe-separated strings
      const keys = (f?.properties?.per_id_keys || "").split("|").filter(Boolean);
      const arrows = (f?.properties?.per_id_arrows || "").split("|").filter(Boolean);
      
      if (keys.length === 0) continue;
      
      // Build a lookup map for arrows by key
      const arrowMap = {};
      keys.forEach((key, index) => {
        arrowMap[key] = arrows[index];
      });
      
      // match only ids present in volumeJSON (try raw id; if not found, try cleaned)
      const matchedIds = [];
      for (const raw of keys) {
        const rawStr = String(raw);
        if (volumeJSON[rawStr]) matchedIds.push(rawStr);
        else {
          const c = cleanLinkId(rawStr);
          if (volumeJSON[c]) matchedIds.push(c);
        }
      }
      if (matchedIds.length === 0) continue;
      
      // aggregate across matched ids
      let totalAllBins = 0;       // sum across all bins and lines (full day)
      let windowSum = 0;          // sum across window (used for filtered_volume)
      let left = 0, right = 0;    // directional window sums
      
      const mergedLines = {};     // { lineId: { timeBins: { 'HH:MM': sum } } }
      const modesUnion = new Set();
      
      for (const id of matchedIds) {
        const entry = volumeJSON[id];
        if (!entry) continue;
        
        // Build per-line bins (all lines) and merge for sidebar
        const allLines = linesToObject(entry);
        mergeLines(mergedLines, allLines);
        
        // Which lines contribute to map symbology/labels?
        const activeLines = filterLineId
        ? (allLines[filterLineId] ? { [filterLineId]: allLines[filterLineId] } : {})
        : allLines;
        
        // Sum full-day total
        totalAllBins += Number(entry.linkTotal ?? 0);
        
        // Sum window across ACTIVE lines only (selected line if set)
        let thisWindow = 0;
        if (isFullDay) {
          for (const lid in activeLines) {
            thisWindow += Number(activeLines[lid]?.total) || 0;
          }
        } else {
          for (const lid in activeLines) {
            const tb = activeLines[lid]?.timeBins || {};
            for (let tick = startTick; tick < endTick; tick++) {
              thisWindow += Number(tb[tickKey(tick)]) || 0;
            }
          }
        }
        windowSum += thisWindow;
        
        // Modes: from active lines when filtered; otherwise link-level
        if (filterLineId) {
          for (const lid in activeLines) {
            const m = activeLines[lid]?.mode;
            if (m) modesUnion.add(String(m));
          }
        } else {
          unionModes(modesUnion, entry.modes_list);
        }
        
        // Split into left/right using the arrow from pipe-separated data
        // Try raw id first; if not present (because we matched a "cleaned" id),
        // try the cleaned key too.
        const arrow =
        arrowMap[id] ??
        arrowMap[cleanLinkId(id)] ??
        null;
        
        if (arrow === "←") left += thisWindow;
        else if (arrow === "→") right += thisWindow;
        else {
          // fallback: split evenly if arrow missing
          left += thisWindow / 2;
          right += thisWindow / 2;
        }
      }
      
      // Build updated feature (shallow clone props)
      features.push({
        ...f,
        properties: {
          ...f.properties,
          // like the road module: color/width use "daily_avg_volume" of the current window
          daily_avg_volume: left + right,
          left_sum: left,
          right_sum: right,
          
          // keep what your working version already used
          total_volume: totalAllBins,
          filtered_volume: windowSum,
          
          // keep these for filtering & sidebar
          modes: Array.from(modesUnion),
          lines: mergedLines,
          line_ids: Object.keys(mergedLines),
          link_ids: matchedIds,
          link_key_join: matchedIds.sort().join(","),
        },
      });
    }
    
    return features;
  }
  
  // ----- initial load --------------------------------------------------------
  
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes" || !searchCanton) return;
    
    const removeLayers = () => {
      [
        "transit-volumes-layer",
        "transit-volumes-hitbox",
        "transit-symbology-line",
        "transit-volumes-highlight",
        "transit-volumes-label-left",
        "transit-volumes-label-right",
        "ant-line",
      ].forEach((id) => map.getLayer(id) && map.removeLayer(id));
      
      ["transit-volumes-source", "transit-volumes-highlight", "ant-path"].forEach(
        (id) => map.getSource(id) && map.removeSource(id)
      );
      
      setSelectedTransitLink(null);
      originalGeoJSON.current = null;
    };
    
    const addLabelLayersIfMissing = () => {
      if (!map.getSource("transit-volumes-source")) return;
      
      const offsetEm = 1;
      const offsetPos = [
        "any",
        [">", ["get", "angle"], 90],
        ["<=", ["get", "angle"], -90],
      ];
      
      // RIGHT-going numbers (above): "NNN →"
      if (!map.getLayer("transit-volumes-label-left")) {
        map.addLayer(
          {
            id: "transit-volumes-label-left",
            type: "symbol",
            source: "transit-volumes-source",
            minzoom: 15,
            layout: {
              "symbol-placement": "line-center",
              "symbol-spacing": 9999999,
              "text-keep-upright": true,
              "text-field": [
                "case",
                ["==", ["round", ["number", ["get", "right_sum"], 0]], 0],
                "",
                [
                  "concat",
                  ["to-string", ["round", ["number", ["get", "right_sum"], 0]]],
                  " \u2192",
                ],
              ],
              "text-size": 11,
              "text-offset": [0, ["case", offsetPos, -offsetEm, offsetEm]],
              "text-allow-overlap": true,
              "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            },
            paint: { "text-halo-width": 1, "text-halo-color": "#ffffff" },
          },
          "transit-volumes-layer"
        );
      }
      
      // LEFT-going numbers (below): "← NNN"
      if (!map.getLayer("transit-volumes-label-right")) {
        map.addLayer(
          {
            id: "transit-volumes-label-right",
            type: "symbol",
            source: "transit-volumes-source",
            minzoom: 15,
            layout: {
              "symbol-placement": "line-center",
              "symbol-spacing": 9999999,
              "text-keep-upright": true,
              "text-field": [
                "case",
                ["==", ["round", ["number", ["get", "left_sum"], 0]], 0],
                "",
                [
                  "concat",
                  "\u2190 ",
                  ["to-string", ["round", ["number", ["get", "left_sum"], 0]]],
                ],
              ],
              "text-size": 11,
              "text-offset": [0, ["case", offsetPos, offsetEm, -offsetEm]],
              "text-allow-overlap": true,
              "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            },
            paint: { "text-halo-width": 1, "text-halo-color": "#ffffff" },
          },
          "transit-volumes-layer"
        );
      }
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
        
        const updatedFeatures = computeFilteredFeatures(networkGeo, volumeJSON, timeRange, highlightedLineId);
        
        map.addSource("transit-volumes-source", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: updatedFeatures,
          },
        });
        
        // Visible line layer — mirror the road “Volumes” color ramp (daily_avg_volume)
        map.addLayer(
          {
            id: "transit-volumes-layer",
            type: "line",
            source: "transit-volumes-source",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": [
                "interpolate",
                ["linear"],
                ["get", "daily_avg_volume"],
                0, "#a1d99b",
                10, "#74c476",
                50, "#41ab5d",
                100, "#238b45",
                250, "#005a32",
              ],
              "line-width": [
                "interpolate",
                ["linear"],
                ["get", "daily_avg_volume"],
                0, 3,
                10, 5,
                50, 7,
                100, 9,
                250, 11,
              ],
            },
          },
          "canton-highlight"
        );
        
        // Hitbox
        map.addLayer(
          {
            id: "transit-volumes-hitbox",
            type: "line",
            source: "transit-volumes-source",
            paint: {
              "line-opacity": 0,
              "line-width": [
                "interpolate",
                ["linear"],
                ["get", "daily_avg_volume"],
                0, 6,
                10, 8,
                50, 10,
                100, 11,
                250, 11,
              ],
            },
          },
          "transit-volumes-layer"
        );
        
        // Labels like roads
        addLabelLayersIfMissing();
        
        // Mode filter applies to both lines and labels
        if (selectedTransitModes && !selectedTransitModes.includes("all")) {
          const filter = [
            "any",
            ...selectedTransitModes.map((mode) => ["in", mode, ["get", "modes"]]),
          ];
          ["transit-volumes-layer", "transit-volumes-hitbox"].forEach((id) => {
            if (map.getLayer(id)) map.setFilter(id, filter);
          });
          ["transit-volumes-label-left", "transit-volumes-label-right"].forEach((id) => {
            if (map.getLayer(id)) map.setFilter(id, filter);
          });
        }
        
        const handleIdle = () => {
          setIsLoading(false);
          map.off("idle", handleIdle);
        };
        map.on("idle", handleIdle);
        
        // Click to highlight + sidebar
        map.on("click", "transit-volumes-hitbox", (e) => {
          if (!e.features?.length) return;
          
          // Identify by our stable key
          const clickedKeys = new Set(
            e.features.map((f) => f?.properties?.link_key_join).filter(Boolean)
          );
          const allFeatures =
          map.getSource("transit-volumes-source")._data.features || [];
          const fullFeatures = clickedKeys.size
          ? allFeatures.filter((f) => clickedKeys.has(f?.properties?.link_key_join))
          : e.features;
          
          if (!fullFeatures.length) return;
          
          if (map.getLayer("transit-volumes-highlight"))
            map.removeLayer("transit-volumes-highlight");
          if (map.getSource("transit-volumes-highlight"))
            map.removeSource("transit-volumes-highlight");
          
          map.addSource("transit-volumes-highlight", {
            type: "geojson",
            data: { type: "FeatureCollection", features: fullFeatures },
          });
          
          map.addLayer(
            {
              id: "transit-volumes-highlight",
              type: "line",
              source: "transit-volumes-highlight",
              paint: {
                "line-width": [
                  "interpolate",
                  ["linear"],
                  ["get", "daily_avg_volume"],
                  0, 8,
                  10, 10,
                  50, 12,
                  100, 14,
                  250, 16,
                ],
                "line-color": "#00ffff",
              },
            },
            "transit-volumes-layer"
          );
          
          // Sidebar: pass properties array
          console.log(fullFeatures.map((f) => f.properties));
          setSelectedTransitLink(fullFeatures.map((f) => f.properties));
        });
      } catch (err) {
        console.warn("Failed to load transit volumes layer", err);
      }
    };
    
    init();
    return () => {
      removeLayers();
    };
  }, [isGraphExpanded, searchCanton]);
  
  // ----- update data on timeRange change -------------------------------------
  
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes" || !originalGeoJSON.current) return;
    
    const { geo, volumes } = originalGeoJSON.current;
    const updatedFeatures = computeFilteredFeatures(geo, volumes, timeRange, highlightedLineId);
    
    const source = map.getSource("transit-volumes-source");
    if (source) {
      source.setData({ type: "FeatureCollection", features: updatedFeatures });
    }
    
    // keep highlights “in sync” with new props
    const highlightSource = map.getSource("transit-volumes-highlight");
    if (highlightSource) {
      const prevHighlight = highlightSource._data?.features || [];
      const prevKeys = new Set(
        prevHighlight.map((f) => f?.properties?.link_key_join).filter(Boolean)
      );
      const updatedHighlight = updatedFeatures.filter((f) =>
        prevKeys.has(f?.properties?.link_key_join)
    );
    highlightSource.setData({
      type: "FeatureCollection",
      features: updatedHighlight,
    });
  }
}, [timeRange, highlightedLineId]);

// ----- respond to mode filter changes (also labels) ------------------------
useEffect(() => {
  const map = mapRef.current;
  if (!map || isGraphExpanded !== "TransitVolumes") return;
  
  // 1) Build the optional mode filter
  const modeFilter =
  selectedTransitModes && !selectedTransitModes.includes("all")
  ? [
    "any",
    ...selectedTransitModes.map((mode) => ["in", mode, ["get", "modes"]]),
  ]
  : null;
  
  // 2) Build the optional "only this line" filter
  const lineFilter = highlightedLineId
  ? ["in", highlightedLineId, ["get", "line_ids"]]
  : null;
  
  // 3) Combine them
  const combinedFilter =
  lineFilter && modeFilter
  ? ["all", lineFilter, modeFilter]
  : lineFilter || modeFilter || null;
  
  // Apply to base, hitbox, highlight, and labels
  const layerIds = [
    "transit-volumes-layer",
    "transit-volumes-hitbox",
    "transit-volumes-highlight",
    "transit-volumes-label-left",
    "transit-volumes-label-right",
    "ant-line",
  ];
  
  layerIds.forEach((id) => {
    if (map.getLayer(id)) map.setFilter(id, combinedFilter);
  });
}, [selectedTransitModes, highlightedLineId, isGraphExpanded]);

}
