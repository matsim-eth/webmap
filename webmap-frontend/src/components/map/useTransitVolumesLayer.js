import { useEffect, useRef } from "react";
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { parsePipeList, pipeMinMax } from './_lib/pipeProps';
import { clearNetworkHighlightData } from './_lib/featureSelection';

export default function useTransitVolumesLayer({
  mapRef,
  isGraphExpanded,
  searchCanton,
  datasetId,
  timeRange,
  loadWithFallback,
  selectedTransitModes,
  setIsLoading,
  setSelectedTransitLink,
  highlightedLineId,
  setFeatureGeoJSON,
  tableFilterQuery,
  drawRef
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
      const keys = parsePipeList(f?.properties?.per_id_keys);
      const arrows = parsePipeList(f?.properties?.per_id_arrows);

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
      let totalLeft = 0, totalRight = 0; // directional full-day sums

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

        // Get the arrow for this link ID
        const arrow =
          arrowMap[id] ??
          arrowMap[cleanLinkId(id)] ??
          null;

        // Sum full-day total
        const linkTotal = Number(entry.linkTotal ?? 0);
        totalAllBins += linkTotal;

        // Split full-day total by direction
        if (arrow === "←") totalLeft += linkTotal;
        else if (arrow === "→") totalRight += linkTotal;
        else {
          // fallback: split evenly if arrow missing
          totalLeft += linkTotal / 2;
          totalRight += linkTotal / 2;
        }

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

        // Split window into left/right using the arrow
        if (arrow === "←") left += thisWindow;
        else if (arrow === "→") right += thisWindow;
        else {
          // fallback: split evenly if arrow missing
          left += thisWindow / 2;
          right += thisWindow / 2;
        }
      }

      // Build updated feature (shallow clone props)
      const props = f.properties;

      // Pipe-delimited min/max for filterable scalar properties
      const cap = pipeMinMax(props.per_id_capacities);
      const len = pipeMinMax(props.per_id_lengths);
      const fre = pipeMinMax(props.per_id_freespeeds);
      const vol = pipeMinMax(props.per_id_daily_avgs);

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

          // Add directional total volumes for table
          total_left: totalLeft,
          total_right: totalRight,

          // Add min/max properties for filtering (default to 0 when empty,
          // matching the previous behavior that fell through to Math.min/max
          // on an empty array → produced 0).
          capacity_min: cap.min ?? 0,
          capacity_max: cap.max ?? 0,
          length_min: len.min ?? 0,
          length_max: len.max ?? 0,
          freespeed_min: fre.min ?? 0,
          freespeed_max: fre.max ?? 0,
          volume_min: vol.min ?? 0,
          volume_max: vol.max ?? 0,

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
      // Remove click handler first
      if (map.getLayer("transit-volumes-hitbox")) {
        map.off("click", "transit-volumes-hitbox", handleTransitVolumeClick);
      }

      safeRemoveLayer(map, [
        "transit-volumes-layer",
        "transit-volumes-hitbox",
        "transit-symbology-line",
        "transit-volumes-label-left",
        "transit-volumes-label-right",
        "ant-line",
      ]);
      safeRemoveSource(map, ["transit-volumes-source", "ant-path"]);

      // Clear network-highlight instead of removing it (shared with network)
      clearNetworkHighlightData(map);

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

    // Define click handler function so it can be properly removed
    const handleTransitVolumeClick = (e) => {
      if (!e.features?.length) return;

      // Skip selection when actively drawing or clicking on draw features
      if (drawRef?.current) {
        const mode = drawRef.current.getMode();
        if (mode === 'draw_polygon' || mode === 'direct_select') return;
        const clickedLayers = mapRef.current.queryRenderedFeatures(e.point).map(fl => fl.layer.id);
        if (clickedLayers.some(id => id.startsWith('gl-draw'))) return;
        // Clear drawn polygons on single-click selection
        if (drawRef.current.getAll?.()?.features?.length > 0) {
          drawRef.current.deleteAll();
          mapRef.current.fire('draw.delete', { features: [] });
        }
      }

      // Identify by our stable key
      const clickedKeys = new Set(
        e.features.map((f) => f?.properties?.link_key_join).filter(Boolean)
      );
      const allFeatures =
        map.getSource("transit-volumes-source")?._data?.features || [];
      const fullFeatures = clickedKeys.size
        ? allFeatures.filter((f) => clickedKeys.has(f?.properties?.link_key_join))
        : e.features;

      if (!fullFeatures.length) return;

      // Use shared network-highlight - ensure it exists and is properly positioned
      if (!map.getSource("network-highlight")) {
        // Create source
        map.addSource("network-highlight", {
          type: "geojson",
          data: { type: "FeatureCollection", features: fullFeatures },
        });
      } else {
        // Update existing source
        map.getSource("network-highlight").setData({
          type: "FeatureCollection",
          features: fullFeatures,
        });
      }

      // Ensure layer exists and is properly positioned
      if (!map.getLayer("network-highlight")) {
        // Position before transit-volumes-layer
        let beforeLayer = null;
        if (map.getLayer('transit-volumes-layer')) beforeLayer = 'transit-volumes-layer';
        else if (map.getLayer('network-layer')) beforeLayer = 'network-layer';

        map.addLayer(
          {
            id: "network-highlight",
            type: "line",
            source: "network-highlight",
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
              "line-color": "#00a2ff",
            },
          },
          beforeLayer
        );
      } else {
        // Layer exists - make sure it's visible and has correct paint
        map.setLayoutProperty("network-highlight", "visibility", "visible");
        // Update paint to work with transit data
        map.setPaintProperty("network-highlight", "line-color", "#00a2ff");
        map.setPaintProperty("network-highlight", "line-width", [
          "interpolate",
          ["linear"],
          ["get", "daily_avg_volume"],
          0, 8,
          10, 10,
          50, 12,
          100, 14,
          250, 16,
        ]);
      }

      // Sidebar: pass properties array
      console.log("Transit link clicked:", fullFeatures.map((f) => f.properties));
      setSelectedTransitLink(fullFeatures.map((f) => f.properties));
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

        // Always pass null for filterLineId on init — highlightedLineId is reset
        // on canton change by TransitVolumesModule, but this async closure captures
        // the stale value. Effects #2/#3 will apply the correct filter once layers exist.
        const updatedFeatures = computeFilteredFeatures(networkGeo, volumeJSON, timeRange, null);

        // Export the GeoJSON for the feature table
        if (setFeatureGeoJSON) {
          setFeatureGeoJSON({
            type: "FeatureCollection",
            features: updatedFeatures,
          });
        }

        map.addSource("transit-volumes-source", {
          type: "geojson",
          generateId: true,
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
          setFilter(map, [
            "transit-volumes-layer", "transit-volumes-hitbox",
            "transit-volumes-label-left", "transit-volumes-label-right",
          ], filter);
        }

        const handleIdle = () => {
          setIsLoading(false);
          map.off("idle", handleIdle);
        };
        map.on("idle", handleIdle);

        // Remove any existing click handler first
        if (map.getLayer("transit-volumes-hitbox")) {
          map.off("click", "transit-volumes-hitbox", handleTransitVolumeClick);
        }

        // Add click handler
        map.on("click", "transit-volumes-hitbox", handleTransitVolumeClick);
      } catch (err) {
        console.warn("Failed to load transit volumes layer", err);
      }
    };

    init();
    return () => {
      removeLayers();
    };
  }, [isGraphExpanded, searchCanton, datasetId]);

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

    // Also update the table GeoJSON so filteredVolume shows correct values
    setFeatureGeoJSON?.({ type: "FeatureCollection", features: updatedFeatures });

    // keep highlights "in sync" with new props (using shared network-highlight)
    const highlightSource = map.getSource("network-highlight");
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
    setFilter(map, [
      "transit-volumes-layer",
      "transit-volumes-hitbox",
      "transit-volumes-highlight",
      "transit-volumes-label-left",
      "transit-volumes-label-right",
      "ant-line",
    ], combinedFilter);
  }, [selectedTransitModes, highlightedLineId, isGraphExpanded]);

  // ----- respond to table filter changes --------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes") return;

    // 1) Build the mode filter
    const modeFilter =
      selectedTransitModes && !selectedTransitModes.includes("all")
        ? [
          "any",
          ...selectedTransitModes.map((mode) => ["in", mode, ["get", "modes"]]),
        ]
        : null;

    // 2) Build the line filter
    const lineFilter = highlightedLineId
      ? ["in", highlightedLineId, ["get", "line_ids"]]
      : null;

    // 3) Build the table filter
    let tableFilter = null;
    if (tableFilterQuery) {
      let { column, value } = tableFilterQuery;

      if (column && value) {
        // Handle comparison operators for numeric columns
        const numericColumns = ["capacity", "length", "freeSpeed", "totalVol", "filteredVolume"];
        const isNumericCol = numericColumns.includes(column);

        if (isNumericCol && /^(>=?|<=?)\s*[0-9.,]+$/.test(value)) {
          const match = value.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
          if (match) {
            const operator = match[1];
            const numValue = parseFloat(match[2].replace(/,/g, ''));

            if (!isNaN(numValue)) {
              if (column === "filteredVolume") {
                const leftFilter = operator === '>' ? [">", ["number", ["get", "left_sum"], 0], numValue]
                  : operator === '<' ? ["<", ["number", ["get", "left_sum"], 0], numValue]
                    : operator === '>=' ? [">=", ["number", ["get", "left_sum"], 0], numValue]
                      : operator === '<=' ? ["<=", ["number", ["get", "left_sum"], 0], numValue]
                        : ["==", ["number", ["get", "left_sum"], 0], numValue];

                const rightFilter = operator === '>' ? [">", ["number", ["get", "right_sum"], 0], numValue]
                  : operator === '<' ? ["<", ["number", ["get", "right_sum"], 0], numValue]
                    : operator === '>=' ? [">=", ["number", ["get", "right_sum"], 0], numValue]
                      : operator === '<=' ? ["<=", ["number", ["get", "right_sum"], 0], numValue]
                        : ["==", ["number", ["get", "right_sum"], 0], numValue];

                tableFilter = ["any", leftFilter, rightFilter];
              } else {
                // For pipe-delimited properties (capacity, length, freeSpeed, totalVol)
                // We need to check if ANY of the pipe-delimited values matches the comparison
                const propMap = {
                  capacity: "per_id_capacities",
                  length: "per_id_lengths",
                  freeSpeed: "per_id_freespeeds",
                  totalVol: "per_id_daily_avgs"
                };

                const propName = propMap[column];
                if (propName) {
                  // Since we can't easily parse pipe-delimited strings in Mapbox expressions,
                  // we'll use a workaround: check min/max properties that were pre-computed
                  const minMaxMap = {
                    capacity: { min: "capacity_min", max: "capacity_max" },
                    length: { min: "length_min", max: "length_max" },
                    freeSpeed: { min: "freespeed_min", max: "freespeed_max" },
                    totalVol: { min: "volume_min", max: "volume_max" }
                  };

                  const minMaxProps = minMaxMap[column];
                  if (minMaxProps) {
                    // Check if ANY value in the range matches the condition
                    // For <, <=: check if min matches
                    // For >, >=: check if max matches
                    if (operator === '<') {
                      tableFilter = ["<", ["number", ["get", minMaxProps.min], 0], numValue];
                    } else if (operator === '<=') {
                      tableFilter = ["<=", ["number", ["get", minMaxProps.min], 0], numValue];
                    } else if (operator === '>') {
                      tableFilter = [">", ["number", ["get", minMaxProps.max], 0], numValue];
                    } else if (operator === '>=') {
                      tableFilter = [">=", ["number", ["get", minMaxProps.max], 0], numValue];
                    }
                  }
                }
              }
            }
          }
        }

        // If no comparison operator match, proceed with normal logic
        if (!tableFilter) {
          const values = String(value).split(/[;,]/).map(v => v.trim()).filter(v => v);

          if (column === "modes") {
            const filters = values.map(val => {
              const valLower = val.toLowerCase();
              return [">=", ["index-of", valLower, ["downcase", ["to-string", ["get", "modes"]]]], 0];
            });
            tableFilter = filters.length > 1 ? ["any", ...filters] : filters[0];
          } else if (column === "filteredVolume") {
            const numericValues = values
              .map(v => v.replace(/,/g, ''))
              .filter(v => !isNaN(Number(v)))
              .map(v => Number(v));

            if (numericValues.length > 0) {
              const tolerance = 0.05;
              const volumeFilters = numericValues.map(val => {
                const minVal = val - tolerance;
                const maxVal = val + tolerance;

                return [
                  "any",
                  [
                    "all",
                    [">=", ["number", ["get", "left_sum"], 0], minVal],
                    ["<=", ["number", ["get", "left_sum"], 0], maxVal]
                  ],
                  [
                    "all",
                    [">=", ["number", ["get", "right_sum"], 0], minVal],
                    ["<=", ["number", ["get", "right_sum"], 0], maxVal]
                  ]
                ];
              });

              tableFilter = volumeFilters.length > 1 ? ["any", ...volumeFilters] : volumeFilters[0];
            }
          } else {
            const columnMap = {
              capacity: "per_id_capacities",
              length: "per_id_lengths",
              freeSpeed: "per_id_freespeeds",
              totalVol: "per_id_daily_avgs",
              directionId: "per_id_keys"
            };

            const propName = columnMap[column];
            if (propName) {
              const valueFilters = values.map(val => {
                return [
                  "any",
                  ["==", ["get", propName], val],
                  ["==", ["index-of", `${val}|`, ["get", propName]], 0],
                  [">=", ["index-of", `|${val}|`, ["get", propName]], 0],
                  [
                    "all",
                    [">=", ["index-of", `|${val}`, ["get", propName]], 0],
                    ["==",
                      ["+",
                        ["index-of", `|${val}`, ["get", propName]],
                        ["length", `|${val}`]
                      ],
                      ["length", ["get", propName]]
                    ]
                  ]
                ];
              });

              tableFilter = valueFilters.length > 1 ? ["any", ...valueFilters] : valueFilters[0];
            }
          }
        }
      } else if (!column && value) {
        // All columns search
        const values = String(value).split(/[;,]/).map(v => v.trim().toLowerCase()).filter(v => v);

        if (values.length === 1) {
          tableFilter = [">=", ["index-of", values[0], ["get", "searchable_text"]], 0];
        } else {
          const valueFilters = values.map(val =>
            [">=", ["index-of", val, ["get", "searchable_text"]], 0]
          );
          tableFilter = ["any", ...valueFilters];
        }
      }
    }

    // 4) Combine all filters
    const filters = [modeFilter, lineFilter, tableFilter].filter(Boolean);
    const combinedFilter = filters.length > 1 ? ["all", ...filters] : filters[0] || null;

    // Apply to all layers
    setFilter(map, [
      "transit-volumes-layer",
      "transit-volumes-hitbox",
      "transit-volumes-highlight",
      "transit-volumes-label-left",
      "transit-volumes-label-right",
      "ant-line",
    ], combinedFilter);
  }, [selectedTransitModes, highlightedLineId, isGraphExpanded, tableFilterQuery]);

}
