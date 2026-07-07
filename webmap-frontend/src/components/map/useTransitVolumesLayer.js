import { useEffect, useRef } from "react";
import { nearestPointOnLine, lineString, point } from "@turf/turf";
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { parsePipeList, pipeMinMax, mergeSegmentsByGeometry } from './_lib/pipeProps';
import { clearNetworkHighlightData, clearAntLine } from './_lib/featureSelection';
import { useData } from '../../context/DataContext';

// ---------------------------------------------------------------------------
// Split-link rendering constants (mirrors useNetworkSplitLayers for the road
// Volumes module). Below SPLIT_ZOOM the merged `transit-volumes-layer` draws one
// line per segment; at/above it that layer is capped out and this overlay draws
// one offset line per direction so a forward+reverse pair becomes two parallel
// clickable lines. The merged features' per_id_keys/per_id_arrows arrays already
// carry everything we need, so no extra fetch — we just regroup them by
// direction and reuse right_sum/left_sum as each direction's windowed volume.
// ---------------------------------------------------------------------------
const SPLIT_ZOOM = 15;
const RIGHT = "→"; // →
const LEFT = "←";  // ←

const SPLIT_SOURCE_ID = "transit-volumes-split-source";
const SPLIT_LAYER_ID = "transit-volumes-split-layer";
// Invisible wide click/hover target over the thin split lines (mirrors the base
// transit-volumes-hitbox). A real layer is used so the hover cursor covers the
// whole target and pickByClickSide can disambiguate the two overlapping lines.
const SPLIT_HITBOX_ID = "transit-volumes-split-hitbox";
// Dedicated offset highlight for a single clicked direction — kept separate from
// the shared network-highlight (used by merged clicks) so a leftover line-offset
// can't pollute the merged highlight paint. Its offset/width are zoom-stepped:
// at/above SPLIT_ZOOM it rides the clicked direction's offset line; below it the
// split lines collapse back into the single merged line, so the highlight snaps
// onto it (offset 0, merged-highlight width) instead of floating offset next to
// it. A top-level ["step", ["zoom"], ...] switches discretely at SPLIT_ZOOM —
// step zoom-curves don't interpolate — so the snap lands exactly on the same
// boundary as the line handoff.
const SPLIT_HIGHLIGHT_ID = "transit-volumes-split-highlight";
// Direction-label ids are preserved from the pre-split implementation so the
// polygon-fade (useLinePolygon labelLayerIds) and the mode/table filter arrays
// keep referencing them. `label-left` shows the right-going "NNN →" number,
// `label-right` the left-going "← NNN" — the historical naming.
const LABEL_RIGHT_ID = "transit-volumes-label-left";
const LABEL_LEFT_ID = "transit-volumes-label-right";
const MERGED_LAYER_ID = "transit-volumes-layer";
const MERGED_HITBOX_ID = "transit-volumes-hitbox";

// Green transit ramp/width on the per-direction windowed volume (`ns_volume`) —
// identical stops to the merged transit-volumes-layer (which colours by
// daily_avg_volume) so a segment's two split lines read on the same scale.
const VOLUME_RAMP = ["interpolate", ["linear"], ["get", "ns_volume"],
  0, "#a1d99b", 10, "#74c476", 50, "#41ab5d", 100, "#238b45", 250, "#005a32"];
const WIDTH_EXPR = ["interpolate", ["linear"], ["get", "ns_volume"],
  0, 3, 10, 5, 50, 7, 100, 9, 250, 11];
// Hitbox is much wider than the visible line so thin links are easy to hit; the
// per-direction offset keeps each direction's target centred on its own line.
const HITBOX_WIDTH_EXPR = ["interpolate", ["linear"], ["get", "ns_volume"],
  0, 8, 10, 10, 50, 12, 100, 14, 250, 16];

// Parallel-direction offset, same convention as useNetworkSplitLayers: line-offset
// is perpendicular to drawing direction, so normalise by bearing (`angle`) to keep
// → visually on the right when the map is north-up. `angle` is coerced to a
// number (0 = east-ish) — the backend merged_segments ships no angle and loop
// links compute to null; an un-coerced null makes the whole offset expression
// error per feature, collapsing both direction lines AND both labels onto the
// centreline (the "stacked labels" bug).
const NUM_ANGLE = ["number", ["get", "angle"], 0];
const isWestish = ["any", [">", NUM_ANGLE, 90], ["<=", NUM_ANGLE, -90]];
// Offset magnitude tracks the volume-driven line width (WIDTH_EXPR: 3..11px) so
// the two parallel direction lines stay separated instead of overlapping when a
// high-volume pair renders fat — a bit more than half the width plus a gap.
const OFFSET_MAG = ["interpolate", ["linear"], ["get", "ns_volume"],
  0, 2.5, 10, 3.5, 50, 4.5, 100, 5.5, 250, 7];
const OFFSET_NEG = ["*", -1, OFFSET_MAG];
const LINE_OFFSET_EXPR = ["case",
  ["!", ["get", "ls_needs_offset"]], 0,
  ["==", ["get", "ls_arrow"], RIGHT],
    ["case", isWestish, OFFSET_NEG, OFFSET_MAG],
  ["case", isWestish, OFFSET_MAG, OFFSET_NEG],
];

// Direction-label text offset — wider gap when both directions are present so the
// number rides its own offset line (same scheme as useNetworkSplitLayers).
const LABEL_OFFSET_NORMAL = 1;
const LABEL_OFFSET_WIDE = 1.6;
const LABEL_OFFSET_RIGHT = [0, ["case",
  ["get", "ls_needs_offset"], ["case", isWestish, -LABEL_OFFSET_WIDE, LABEL_OFFSET_WIDE],
  ["case", isWestish, -LABEL_OFFSET_NORMAL, LABEL_OFFSET_NORMAL],
]];
const LABEL_OFFSET_LEFT = [0, ["case",
  ["get", "ls_needs_offset"], ["case", isWestish, LABEL_OFFSET_WIDE, -LABEL_OFFSET_WIDE],
  ["case", isWestish, LABEL_OFFSET_NORMAL, -LABEL_OFFSET_NORMAL],
]];

// Regroup each merged transit segment's links by direction into per-direction
// features. Each split feature spreads the parent props (so modes/line_ids/
// per_id_* / the min-max scalars all carry over and the existing filter
// expressions work unchanged) and sets ns_volume from the parent's windowed
// right_sum/left_sum for the colour ramp + labels. Directions use the MATCHED
// pt ids (right_ids/left_ids from computeFilteredFeatures) when present — the
// backend merges ALL links sharing a geometry, so regrouping raw per_id_keys
// would drag car link ids into a transit selection; the per_id_keys regroup
// remains as a fallback for features computed before those props existed.
function buildSplitFeatures(features) {
  const out = [];
  for (let idx = 0; idx < features.length; idx++) {
    const f = features[idx];
    const props = f.properties || {};
    let right, left;
    if (props.right_ids !== undefined || props.left_ids !== undefined) {
      right = parsePipeList(props.right_ids);
      left = parsePipeList(props.left_ids);
    } else {
      const keys = parsePipeList(props.per_id_keys);
      if (!keys.length) continue;
      const arrows = parsePipeList(props.per_id_arrows);
      right = [];
      left = [];
      for (let i = 0; i < keys.length; i++) {
        (arrows[i] === LEFT ? left : right).push(keys[i]);
      }
    }
    const needsOffset = right.length > 0 && left.length > 0;
    const rightVol = Number(props.right_sum) || 0;
    const leftVol = Number(props.left_sum) || 0;
    const mk = (ids, arrow, vol) => ({
      type: "Feature",
      id: idx,
      geometry: f.geometry,
      properties: {
        ...props,
        ls_arrow: arrow,
        ls_needs_offset: needsOffset,
        ls_link_ids: ids.join("|"),
        ns_volume: vol,
      },
    });
    if (right.length) out.push(mk(right, RIGHT, rightVol));
    if (left.length) out.push(mk(left, LEFT, leftVol));
  }
  return out;
}

// Both split features of a segment share one geometry, so queryRenderedFeatures
// returns both on a click — disambiguate by comparing the click's side (cross
// product against the nearest segment) to each feature's paint-offset sign
// (same approach as useNetworkSplitLayers.pickByClickSide).
function pickByClickSide(hits, clickLngLat) {
  if (hits.length === 1) return hits[0];
  const ref = hits[0];
  if (!ref.properties.ls_needs_offset) return ref;
  const geom = ref.geometry;
  const coords = geom.type === "LineString" ? geom.coordinates : geom.coordinates[0];
  if (!coords || coords.length < 2) return ref;
  const snap = nearestPointOnLine(lineString(coords), point([clickLngLat.lng, clickLngLat.lat]));
  const i = Math.min(snap.properties.index ?? 0, coords.length - 2);
  const a = coords[i], b = coords[i + 1];
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = clickLngLat.lng - a[0], wy = clickLngLat.lat - a[1];
  const clickIsRight = (vx * wy - vy * wx) < 0;
  const offsetSign = (arrow, angle) => {
    const isWest = angle > 90 || angle <= -90;
    if (arrow === RIGHT) return isWest ? -1 : 1;
    return isWest ? 1 : -1;
  };
  const want = clickIsRight ? 1 : -1;
  return hits.find(h => offsetSign(h.properties.ls_arrow, h.properties.angle) === want) || ref;
}

// Apply the combined mode/line/table filter to every line + hitbox layer, and to
// the two direction-label layers with their ls_arrow constraint AND-ed in (the
// labels live on the split source now, so each must stay pinned to its own
// direction rather than rendering on both).
function applyLayerFilters(map, combinedFilter) {
  setFilter(map, [MERGED_LAYER_ID, MERGED_HITBOX_ID, SPLIT_LAYER_ID, SPLIT_HITBOX_ID, "ant-line"], combinedFilter);
  const rightArrow = ["==", ["get", "ls_arrow"], RIGHT];
  const leftArrow = ["==", ["get", "ls_arrow"], LEFT];
  setFilter(map, LABEL_RIGHT_ID, combinedFilter ? ["all", rightArrow, combinedFilter] : rightArrow);
  setFilter(map, LABEL_LEFT_ID, combinedFilter ? ["all", leftArrow, combinedFilter] : leftArrow);
}

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
  labelSize,
  drawRef
}) {
  const originalGeoJSON = useRef(null);
  // Per-link volume lookup for the sidebar (see DataContext) — published here
  // because this hook is the only place the raw volume JSON is available.
  const { setTransitVolumesByLink } = useData();

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

  // Normalize the raw volume JSON into { link_id: { lines, linkTotal,
  // modes_list } } with linesToObject-shaped lines (timeBins/total always
  // present) — the DataContext bucket the attributes table narrows by link.
  const buildVolumesByLink = (rawVolumeJSON) => {
    const byId = toVolumeById(rawVolumeJSON);
    const out = Object.create(null);
    for (const [id, entry] of Object.entries(byId)) {
      const lines = linesToObject(entry);
      const linkTotal = Number(entry.linkTotal)
        || Object.values(lines).reduce((s, l) => s + (Number(l.total) || 0), 0);
      out[id] = { lines, linkTotal, modes_list: entry.modes_list || [] };
    }
    return out;
  };

  // Bearing of first→last coord in degrees, range (-180, 180], mirroring
  // decorateLineVolumesFromPerId. The split offset + labels key off `angle`, and
  // the transit merged_segments geometry isn't run through that decorator, so
  // derive it here when the loaded feature doesn't already carry one.
  function computeAngle(f) {
    const existing = Number(f?.properties?.angle);
    if (Number.isFinite(existing)) return existing;
    const g = f?.geometry;
    if (g?.type !== "LineString" || !(g.coordinates?.length > 1)) return null;
    const c = g.coordinates;
    const [x0, y0] = c[0];
    const [x1, y1] = c[c.length - 1];
    if (x1 === x0 && y1 === y0) return null;
    return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  }

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
      const leftIds = [], rightIds = []; // matched pt ids per direction (split overlay)

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

        // Direction id buckets for the split overlay (unknown arrow → right,
        // matching buildSplitFeatures' regroup bias).
        (arrow === "←" ? leftIds : rightIds).push(id);

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
          // Bearing for the split offset + direction labels (derive if absent).
          angle: computeAngle(f),
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

          // Matched pt ids per direction — consumed by buildSplitFeatures so the
          // split overlay's ls_link_ids only ever carry transit links.
          right_ids: rightIds.join("|"),
          left_ids: leftIds.join("|"),

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
      // Remove event handlers first
      if (map.getLayer(MERGED_HITBOX_ID)) {
        map.off("click", MERGED_HITBOX_ID, handleTransitVolumeClick);
      }
      if (map.getLayer(SPLIT_HITBOX_ID)) {
        map.off("click", SPLIT_HITBOX_ID, handleSplitClick);
        map.off("mouseenter", SPLIT_HITBOX_ID, onSplitEnter);
        map.off("mouseleave", SPLIT_HITBOX_ID, onSplitLeave);
      }

      safeRemoveLayer(map, [
        MERGED_LAYER_ID,
        MERGED_HITBOX_ID,
        "transit-symbology-line",
        LABEL_RIGHT_ID,
        LABEL_LEFT_ID,
        SPLIT_LAYER_ID,
        SPLIT_HITBOX_ID,
        SPLIT_HIGHLIGHT_ID,
        "ant-line",
      ]);
      safeRemoveSource(map, ["transit-volumes-source", SPLIT_SOURCE_ID, SPLIT_HIGHLIGHT_ID, "ant-path"]);

      // Clear network-highlight instead of removing it (shared with network)
      clearNetworkHighlightData(map);

      setSelectedTransitLink(null);
      setTransitVolumesByLink(null);
      originalGeoJSON.current = null;
    };

    // Direction labels now ride the split source with the per-direction offset,
    // and are inserted with NO beforeId so they paint ON TOP of every line layer
    // (fixes the old z-order bug where labels sat under transit-volumes-layer).
    const addLabelLayersIfMissing = () => {
      if (!map.getSource(SPLIT_SOURCE_ID)) return;

      const size = Number(labelSize) || 11;
      const common = {
        "symbol-placement": "line-center",
        "symbol-spacing": 9999999,
        "text-keep-upright": true,
        "text-size": size,
        "text-allow-overlap": true,
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      };
      const paint = { "text-halo-width": 1, "text-halo-color": "#ffffff" };

      // RIGHT-going numbers: "NNN →"  (id kept as transit-volumes-label-left)
      if (!map.getLayer(LABEL_RIGHT_ID)) {
        map.addLayer({
          id: LABEL_RIGHT_ID,
          type: "symbol",
          source: SPLIT_SOURCE_ID,
          minzoom: SPLIT_ZOOM,
          filter: ["==", ["get", "ls_arrow"], RIGHT],
          layout: {
            ...common,
            "text-field": [
              "case",
              ["==", ["round", ["get", "ns_volume"]], 0],
              "",
              ["concat", ["to-string", ["round", ["get", "ns_volume"]]], " →"],
            ],
            "text-offset": LABEL_OFFSET_RIGHT,
          },
          paint,
        });
      }

      // LEFT-going numbers: "← NNN"  (id kept as transit-volumes-label-right)
      if (!map.getLayer(LABEL_LEFT_ID)) {
        map.addLayer({
          id: LABEL_LEFT_ID,
          type: "symbol",
          source: SPLIT_SOURCE_ID,
          minzoom: SPLIT_ZOOM,
          filter: ["==", ["get", "ls_arrow"], LEFT],
          layout: {
            ...common,
            "text-field": [
              "case",
              ["==", ["round", ["get", "ns_volume"]], 0],
              "",
              ["concat", "← ", ["to-string", ["round", ["get", "ns_volume"]]]],
            ],
            "text-offset": LABEL_OFFSET_LEFT,
          },
          paint,
        });
      }
    };

    // Merged-segment click (zoom < SPLIT_ZOOM): select the whole segment (all
    // directions) via the shared network-highlight, exactly as before.
    const handleTransitVolumeClick = (e) => {
      if (!e.features?.length) return;

      // At/above SPLIT_ZOOM only the split hitbox handles clicks — a merged
      // (all-direction) selection would be wrong while the offset pair is shown.
      if (map.getZoom() >= SPLIT_ZOOM) return;

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

      // A merged click supersedes any split-direction highlight.
      safeRemoveLayer(map, SPLIT_HIGHLIGHT_ID);
      safeRemoveSource(map, SPLIT_HIGHLIGHT_ID);
      clearAntLine(map);

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
        if (map.getLayer(MERGED_LAYER_ID)) beforeLayer = MERGED_LAYER_ID;
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
        // Update paint to work with transit data. Reset line-offset in case a
        // previous split highlight (which reuses no shared layer now, but be safe)
        // left one behind.
        map.setPaintProperty("network-highlight", "line-color", "#00a2ff");
        map.setPaintProperty("network-highlight", "line-offset", 0);
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
      setSelectedTransitLink(fullFeatures.map((f) => f.properties));
    };

    // Split-line click (zoom >= SPLIT_ZOOM): select ONLY the clicked direction.
    const handleSplitClick = (e) => {
      if (!e.features?.length) return;

      // Skip selection when actively drawing or clicking on draw features
      if (drawRef?.current) {
        const mode = drawRef.current.getMode?.();
        if (mode === 'draw_polygon' || mode === 'direct_select') return;
        const clickedLayers = map.queryRenderedFeatures(e.point).map(fl => fl.layer.id);
        if (clickedLayers.some(id => id.startsWith('gl-draw'))) return;
        // Clear drawn polygons on single-click selection
        if (drawRef.current.getAll?.()?.features?.length > 0) {
          drawRef.current.deleteAll();
          map.fire('draw.delete', { features: [] });
        }
      }

      const rendered = pickByClickSide(e.features, e.lngLat);

      // queryRenderedFeatures JSON-stringifies nested properties (lines /
      // link_ids / modes become strings) and clips geometry to the tile, so
      // resolve the real split feature from the source — the sidebar needs the
      // object props and the highlight the full untruncated line. Same trick as
      // the merged handler's link_key_join lookup.
      const splitFeatures = map.getSource(SPLIT_SOURCE_ID)?._data?.features || [];
      const clicked = splitFeatures.find(
        (f) =>
          f?.properties?.link_key_join === rendered?.properties?.link_key_join &&
          f?.properties?.ls_arrow === rendered?.properties?.ls_arrow
      ) || rendered;

      // Drop any ant-path left over from a previous link's "Visualize", and empty
      // the shared merged highlight so both selections aren't shown at once.
      clearAntLine(map);
      clearNetworkHighlightData(map);

      // Offset highlight for the single clicked direction (zoom-stepped — see
      // the SPLIT_HIGHLIGHT_ID comment at the const declarations). The sidebar
      // selection is untouched by the zoom handoff; only the visual anchor
      // shifts between the merged line and the direction's offset line.
      safeRemoveLayer(map, SPLIT_HIGHLIGHT_ID);
      safeRemoveSource(map, SPLIT_HIGHLIGHT_ID);
      map.addSource(SPLIT_HIGHLIGHT_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [clicked] },
      });
      map.addLayer({
        id: SPLIT_HIGHLIGHT_ID,
        type: "line",
        source: SPLIT_HIGHLIGHT_ID,
        paint: {
          // >= SPLIT_ZOOM: keyed on ns_volume (NOT capacity — often NULL on pt
          // links) with the hitbox's stops, so the highlight always renders
          // wider than the split line. Below: the merged network-highlight's
          // ramp so it hugs the single merged line.
          "line-width": ["step", ["zoom"],
            ["interpolate", ["linear"], ["get", "daily_avg_volume"],
              0, 8, 10, 10, 50, 12, 100, 14, 250, 16],
            SPLIT_ZOOM, HITBOX_WIDTH_EXPR],
          "line-color": "#00a2ff",
          "line-opacity": 1,
          "line-offset": ["step", ["zoom"], 0, SPLIT_ZOOM, LINE_OFFSET_EXPR],
        },
        // Under the merged layer (and thus under the split layers stacked above
        // it) so the highlight reads as an outline ring below the link at every
        // zoom, mirroring the merged network-highlight insertion.
      }, map.getLayer(MERGED_LAYER_ID) ? MERGED_LAYER_ID
        : map.getLayer(SPLIT_LAYER_ID) ? SPLIT_LAYER_ID : undefined);

      // Sidebar: single direction. props carry ls_arrow / ls_needs_offset /
      // ls_link_ids so the module can isolate this direction (no dropdown).
      setSelectedTransitLink([clicked.properties]);
    };

    const onSplitEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    const onSplitLeave = () => { map.getCanvas().style.cursor = ""; };

    const init = async () => {
      removeLayers();

      try {
        setIsLoading(true);

        const networkPath = `matsim/${searchCanton}_merged_segments.geojson`;
        const volumePath = `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${searchCanton}.json`;

        const networkGeo = await loadWithFallback(networkPath);
        const volumeJSON = await loadWithFallback(volumePath);

        // The backend serves merged_segments pre-merged (per_id_keys present →
        // no-op), but the GitHub-CDN fallback ships one feature per directed
        // link with a singular `link_id` and NO per_id_* arrays. Without this
        // merge (which useNetworkLayers already does for the road modules) every
        // CDN feature is skipped by computeFilteredFeatures (no per_id_keys) or,
        // worse, direction pairs render as two unmerged overlapping features.
        networkGeo.features = mergeSegmentsByGeometry(networkGeo.features);

        originalGeoJSON.current = { geo: networkGeo, volumes: volumeJSON };
        setTransitVolumesByLink(buildVolumesByLink(volumeJSON));

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

        // Visible merged line layer — mirror the road “Volumes” color ramp
        // (daily_avg_volume). Shown only below SPLIT_ZOOM (capped further down).
        map.addLayer(
          {
            id: MERGED_LAYER_ID,
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

        // Merged hitbox
        map.addLayer(
          {
            id: MERGED_HITBOX_ID,
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
          MERGED_LAYER_ID
        );

        // Per-direction split overlay (offset lines) for zoom >= SPLIT_ZOOM,
        // built from the same features regrouped by direction.
        map.addSource(SPLIT_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: buildSplitFeatures(updatedFeatures) },
        });

        map.addLayer({
          id: SPLIT_LAYER_ID,
          type: "line",
          source: SPLIT_SOURCE_ID,
          minzoom: SPLIT_ZOOM,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": VOLUME_RAMP,
            "line-width": WIDTH_EXPR,
            "line-opacity": 1,
            "line-offset": LINE_OFFSET_EXPR,
          },
        });

        // Invisible wide hitbox over the split lines — click + hover bind here.
        map.addLayer({
          id: SPLIT_HITBOX_ID,
          type: "line",
          source: SPLIT_SOURCE_ID,
          minzoom: SPLIT_ZOOM,
          paint: {
            "line-width": HITBOX_WIDTH_EXPR,
            "line-color": "#000",
            "line-opacity": 0,
            "line-offset": LINE_OFFSET_EXPR,
          },
        });

        // Direction labels (on the split source, on top of every line layer).
        addLabelLayersIfMissing();

        // Hand off merged ↔ split: merged only below SPLIT_ZOOM, split overlay
        // only at/above it (its minzoom). Prevents the merged line drawing under
        // the offset pair.
        if (map.getLayer(MERGED_LAYER_ID)) map.setLayerZoomRange(MERGED_LAYER_ID, 0, SPLIT_ZOOM);

        // Mode filter applies to every line/hitbox/label layer.
        if (selectedTransitModes && !selectedTransitModes.includes("all")) {
          const filter = [
            "any",
            ...selectedTransitModes.map((mode) => ["in", mode, ["get", "modes"]]),
          ];
          applyLayerFilters(map, filter);
        }

        const handleIdle = () => {
          setIsLoading(false);
          map.off("idle", handleIdle);
        };
        map.on("idle", handleIdle);

        // Bind click/hover handlers (idempotent — remove any stale binding first).
        map.off("click", MERGED_HITBOX_ID, handleTransitVolumeClick);
        map.on("click", MERGED_HITBOX_ID, handleTransitVolumeClick);
        map.off("click", SPLIT_HITBOX_ID, handleSplitClick);
        map.on("click", SPLIT_HITBOX_ID, handleSplitClick);
        map.on("mouseenter", SPLIT_HITBOX_ID, onSplitEnter);
        map.on("mouseleave", SPLIT_HITBOX_ID, onSplitLeave);
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

    // Rebuild the per-direction split source so the offset lines + labels track
    // the new time window / highlighted line.
    const splitSource = map.getSource(SPLIT_SOURCE_ID);
    const splitFeatures = buildSplitFeatures(updatedFeatures);
    if (splitSource) {
      splitSource.setData({ type: "FeatureCollection", features: splitFeatures });
    }

    // Keep a split-direction highlight in sync too (same link_key_join refresh
    // the shared network-highlight gets below, plus the ls_arrow match).
    const splitHighlight = map.getSource(SPLIT_HIGHLIGHT_ID);
    if (splitHighlight) {
      const prev = splitHighlight._data?.features || [];
      const updatedHl = splitFeatures.filter((f) =>
        prev.some(
          (p) =>
            p?.properties?.link_key_join === f?.properties?.link_key_join &&
            p?.properties?.ls_arrow === f?.properties?.ls_arrow
        )
      );
      splitHighlight.setData({ type: "FeatureCollection", features: updatedHl });
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

  // ----- label size slider → update split label text-size in place -----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes") return;
    const size = Number(labelSize) || 11;
    [LABEL_RIGHT_ID, LABEL_LEFT_ID].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "text-size", size);
    });
  }, [labelSize, isGraphExpanded]);

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

    // Apply to merged + split line/hitbox layers and the direction labels.
    applyLayerFilters(map, combinedFilter);
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

    // Apply to merged + split line/hitbox layers and the direction labels.
    applyLayerFilters(map, combinedFilter);
  }, [selectedTransitModes, highlightedLineId, isGraphExpanded, tableFilterQuery]);

}
