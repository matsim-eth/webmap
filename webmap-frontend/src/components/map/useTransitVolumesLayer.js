import { useEffect, useRef, useState } from "react";
import { nearestPointOnLine, lineString, point } from "@turf/turf";
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { parsePipeList, pipeMinMax } from './_lib/pipeProps';
import { loadNetworkGeometry } from './_lib/networkGeometry';
import { loadPtVolumeBundle } from './_lib/ptVolumes';
import { paddingSettled } from './_lib/paddingGate';
import { filterTransitFeatures, transitModesOf } from './_lib/transitLinks';
import { clearNetworkHighlightData, clearAntLine } from './_lib/featureSelection';
import { directionLetter } from '../../utils/directionUtils';
import { useData } from '../../context/DataContext';
import useRouteDirections from '../../hooks/useRouteDirections';

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

// Terminus marker shown while a direction (outbound/return) is selected on the
// highlighted line — mirrors the Transit Stops module (useTransitLines). The
// terminus stop's coord + name come straight from route_directions.json, so no
// route geometry is needed (Transit Volumes only loads merged network segments).
const TERMINUS_SOURCE = "transit-volumes-terminus";
const TERMINUS_LAYERS = ["transit-volumes-terminus-circle", "transit-volumes-terminus-label"];
const removeTerminusMarker = (map) => {
  safeRemoveLayer(map, TERMINUS_LAYERS);
  safeRemoveSource(map, TERMINUS_SOURCE);
};

// Stage-1 width: by capacity, exactly like the road network's base rendering in
// useNetworkLayers. The colour stays on the volume ramp (everything reads 0, so
// the whole network comes up at the ramp's low end and then fills in) — same
// placeholder the road Volumes module shows before its volumes arrive.
// `coalesce` because PT-only links (rail, tram, funicular) often carry no
// capacity, and a null would make the interpolation error out per feature.
const PENDING_WIDTH_EXPR = ["interpolate", ["linear"],
  ["coalesce", ["get", "capacity"], 1000], 300, 1, 4000, 8];

// Merged-layer ramp/width on the windowed segment total (`daily_avg_volume`),
// mirroring the road "Volumes" module.
const MERGED_RAMP = ["interpolate", ["linear"], ["get", "daily_avg_volume"],
  0, "#a1d99b", 10, "#74c476", 50, "#41ab5d", 100, "#238b45", 250, "#005a32"];
const MERGED_WIDTH_EXPR = ["interpolate", ["linear"], ["get", "daily_avg_volume"],
  0, 3, 10, 5, 50, 7, 100, 9, 250, 11];
const MERGED_HITBOX_WIDTH_EXPR = ["interpolate", ["linear"], ["get", "daily_avg_volume"],
  0, 6, 10, 8, 50, 10, 100, 11, 250, 11];

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
// pt ids (right_ids/left_ids from prepareFeatures) when present — the
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

// Re-point the highlight sources at the equivalent features in a freshly
// computed set — same segment via link_key_join, same direction via ls_arrow.
// Used on every recompute (time / line / direction) and on the stage-2 handover,
// where the user may have clicked a link while only the geometry was loaded.
// Returns the matched features so the caller can refresh the sidebar from them.
function syncHighlights(map, features, splitFeatures) {
  const matchedSplit = [];
  const splitHighlight = map.getSource(SPLIT_HIGHLIGHT_ID);
  if (splitHighlight) {
    const prev = splitHighlight._data?.features || [];
    for (const f of splitFeatures) {
      const hit = prev.some(
        (p) =>
          p?.properties?.link_key_join === f?.properties?.link_key_join &&
          p?.properties?.ls_arrow === f?.properties?.ls_arrow
      );
      if (hit) matchedSplit.push(f);
    }
    splitHighlight.setData({ type: "FeatureCollection", features: matchedSplit });
  }

  const matchedMerged = [];
  const highlightSource = map.getSource("network-highlight");
  if (highlightSource) {
    const prevKeys = new Set(
      (highlightSource._data?.features || [])
        .map((f) => f?.properties?.link_key_join)
        .filter(Boolean)
    );
    for (const f of features) {
      if (prevKeys.has(f?.properties?.link_key_join)) matchedMerged.push(f);
    }
    highlightSource.setData({ type: "FeatureCollection", features: matchedMerged });
  }

  return { merged: matchedMerged, split: matchedSplit };
}

// "Only this line" map filter, direction-aware: with a route-direction (.H/.R)
// active it matches that direction's line membership so segments the line only
// serves the other way drop out. Returns null while the volume data is still
// loading — line membership is derived from it, so filtering the stage-1
// features by line would match nothing and blank the map.
function buildLineFilter(highlightedLineId, selectedDirection, detailReady) {
  if (!highlightedLineId || !detailReady) return null;
  const dirLetter = directionLetter(selectedDirection);
  const lineProp = dirLetter === 'H' ? 'line_ids_h' : dirLetter === 'R' ? 'line_ids_r' : 'line_ids';
  return ["in", highlightedLineId, ["get", lineProp]];
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
  selectedDirection,
  labelSize,
  drawRef
}) {
  const originalGeoJSON = useRef(null);
  // Per-link volume lookup for the sidebar (see DataContext) — published here
  // because this hook is the only place the raw volume JSON is available.
  // `setTransitVolumesDetailPending` drives the module's "loading volumes"
  // affordance while stage 2 is in flight.
  const { setTransitVolumesByLink, setTransitVolumesDetailPending: setDetailPending } = useData();

  // Two-stage load bookkeeping. `detailReady` is state (not a ref) because the
  // filter effects must re-run when the volume data lands — the line filter is
  // volume-derived and stays off until then. `runIdRef` invalidates a stage
  // still in flight when the canton/dataset/module changes under it.
  const [detailReady, setDetailReady] = useState(false);
  const runIdRef = useRef(0);

  // Live filter state for stage 2, which resolves long after init's closure was
  // created and must honour whatever the user has since selected.
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;
  const highlightedLineIdRef = useRef(highlightedLineId);
  highlightedLineIdRef.current = highlightedLineId;
  const selectedDirectionRef = useRef(selectedDirection);
  selectedDirectionRef.current = selectedDirection;
  // Per-line H/R terminus names + coords for the direction terminus marker
  // (null until route_directions.json resolves; legacy datasets stay null and
  // the marker simply doesn't render — the direction filter is inert there too).
  const routeDirections = useRouteDirections();

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
          // No defensive copy: `bins` comes straight from the freshly parsed
          // payload and nothing downstream mutates it (mergeLines accumulates
          // into its own objects).
          timeBins: bins,
          line_name: l.line_name ?? null,
          mode: l.mode ?? null,
          directions: l.directions ?? null,
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
          directions: l.directions ?? null,
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
          directions: line.directions ?? null,
          total: Number(line.total) || Object.values(bins).reduce((a, v) => a + (Number(v) || 0), 0),
        };
      }
    }
    return out;
  };

  // merge { [lineId]: { timeBins, line_name, mode, directions, total } } into accumulator
  const mergeLines = (acc, src) => {
    for (const [lineId, line] of Object.entries(src || {})) {
      if (!acc[lineId]) {
        acc[lineId] = { timeBins: {}, line_name: line.line_name ?? null, mode: line.mode ?? null, directions: null, total: 0 };
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

      // merge per-direction (.H/.R) bins when the source carries them
      if (line.directions) {
        const dstDirs = acc[lineId].directions || (acc[lineId].directions = {});
        for (const [d, bins] of Object.entries(line.directions)) {
          const dst = dstDirs[d] || (dstDirs[d] = {});
          for (const k in bins) dst[k] = (dst[k] ?? 0) + (Number(bins[k]) || 0);
        }
      }
    }
  };

  const unionModes = (acc, modes) => {
    if (Array.isArray(modes)) modes.forEach((m) => acc.add(String(m)));
    else if (typeof modes === "string")
      modes.split(",").forEach((m) => m && acc.add(m.trim()));
  };

  // Normalize a volume index into { link_id: { lines, linkTotal, modes_list } }
  // with linesToObject-shaped lines (timeBins/total always present) — the shape
  // prepareFeatures/recomputeWindows read AND the DataContext bucket the
  // attributes table narrows by link.
  //
  // toVolumeById already emits exactly this for the normal array payload, so
  // re-deriving it was a second full sweep of every link-line pair for no
  // change in value. Only the legacy object-keyed payload needs the pass.
  const normalizeVolumeIndex = (byId, alreadyNormalized) => {
    if (alreadyNormalized) return byId;
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

  // Invariant per-canton prep (run ONCE per canton in init). Parses each merged
  // segment's link ids/arrows, matches them to the volume index, and builds
  // everything that does NOT depend on the time window / highlighted line /
  // direction: the merged per-line bins for the sidebar, H/R line membership,
  // full-day totals, direction id buckets, and the filterable min/max scalars.
  // recomputeWindows() then only re-sums the windowed directional volumes on each
  // interaction — the expensive parse/match/merge here is done once and reused.
  // Returns [{ f, links: [{id, arrow}], invariant: {...props} }].
  //
  // `features` is the PT-capable subset (see transitLinks.js), NOT the whole
  // canton — the road links can never appear in the volume index, so sweeping
  // them was ~3.5× wasted work.
  //
  // A link with no volume rows is dropped, EXCEPT when its transit modes are
  // ones this dataset can never express on geometry. Some modes record their
  // volumes only against `pt_*` stop pseudo-links rather than the network links
  // they run over — in dataset 3 that is every ferry (127) and subway (79)
  // link, so those modes could never render in any canton. Those are kept at
  // zero; a bus-allowed residential street with no service is not, because bus
  // volumes DO land on geometry, so its absence from the index is real
  // information (in Zürich that distinction is 13k links of noise).
  function prepareFeatures(features, volumeById, hasSourceVolumes) {
    const prepared = [];
    // Modes the volume payload actually attaches to real network links. Built
    // from the index alone (ids, not geometry), so it costs one cheap pass.
    const servedModes = new Set();
    for (const [id, entry] of Object.entries(volumeById)) {
      if (id.startsWith("pt_")) continue;
      for (const m of entry?.modes_list || []) servedModes.add(String(m));
    }
    // volume_min/max drive the table's numeric "Total Volume" map filter and are
    // read off the geometry's own `per_id_daily_avgs` (road volumes — present on
    // the legacy CDN asset, absent on v2). The shared geometry is also handed to
    // the road modules, which bake their backend traffic volumes into that same
    // property, so honour the loader's source flag: without it, whether a
    // v2 dataset's transit filter saw 0 or road volumes would depend on whether
    // the user had visited the Volumes module first.
    const useSourceVolumes = hasSourceVolumes !== false;

    for (const f of features) {
      const keys = parsePipeList(f?.properties?.per_id_keys);
      const arrows = parsePipeList(f?.properties?.per_id_arrows);
      if (keys.length === 0) continue;

      const arrowMap = {};
      keys.forEach((key, index) => { arrowMap[key] = arrows[index]; });

      // match only ids present in the volume index (raw id, else cleaned)
      const matchedIds = [];
      for (const raw of keys) {
        const rawStr = String(raw);
        if (volumeById[rawStr]) matchedIds.push(rawStr);
        else {
          const c = cleanLinkId(rawStr);
          if (volumeById[c]) matchedIds.push(c);
        }
      }

      let totalAllBins = 0;              // full-day sum across all bins/lines
      let totalLeft = 0, totalRight = 0; // directional full-day sums
      const leftIds = [], rightIds = []; // matched pt ids per direction (split overlay)
      const mergedLines = {};            // { lineId: { timeBins, directions, ... } }
      const modesUnion = new Set();
      // Per-link {id, arrow} plan consumed by recomputeWindows (order-independent).
      const links = [];

      for (const id of matchedIds) {
        const entry = volumeById[id];
        if (!entry) continue;

        // Merge per-line bins (all lines on this link) for the sidebar. The
        // index is already normalised (see normalizeVolumeIndex), so re-running
        // linesToObject per link here only re-allocated identical objects.
        mergeLines(mergedLines, entry.lines);

        const arrow = arrowMap[id] ?? arrowMap[cleanLinkId(id)] ?? null;
        links.push({ id, arrow });

        // Direction id buckets for the split overlay (unknown arrow → right,
        // matching buildSplitFeatures' regroup bias).
        (arrow === "←" ? leftIds : rightIds).push(id);

        const linkTotal = Number(entry.linkTotal ?? 0);
        totalAllBins += linkTotal;
        if (arrow === "←") totalLeft += linkTotal;
        else if (arrow === "→") totalRight += linkTotal;
        else { totalLeft += linkTotal / 2; totalRight += linkTotal / 2; }

        // Unfiltered (segment-level) mode union — the filtered case derives its
        // single mode from mergedLines in recomputeWindows.
        unionModes(modesUnion, entry.modes_list);
      }

      // No matched links. Keep the link only if none of its transit modes are
      // ones the payload puts on geometry — i.e. it is unrenderable-by-data
      // (ferry/subway), not simply unserved. Then fall back to the geometry's
      // own ids/arrows/modes so it still renders, still splits by direction at
      // high zoom, and still answers the mode filter. Without the direction
      // fallback buildSplitFeatures would see defined-but-empty right_ids/
      // left_ids, trust them, and drop the link past SPLIT_ZOOM.
      if (!matchedIds.length) {
        const linkModes = transitModesOf(f.properties?.modes);
        if (!linkModes.length || linkModes.some((m) => servedModes.has(m))) continue;
        for (const raw of keys) {
          (arrowMap[raw] === "←" ? leftIds : rightIds).push(String(raw));
        }
        for (const m of linkModes) modesUnion.add(m);
      }

      // Per-direction line membership for the H/R map filter. Lines with no
      // direction data are listed in both so the filter can't hide them.
      const lineIdsH = [], lineIdsR = [];
      for (const [lid, line] of Object.entries(mergedLines)) {
        const d = line.directions;
        if (!d) { lineIdsH.push(lid); lineIdsR.push(lid); continue; }
        if (d.H && Object.keys(d.H).length) lineIdsH.push(lid);
        if (d.R && Object.keys(d.R).length) lineIdsR.push(lid);
      }

      const props = f.properties;
      const cap = pipeMinMax(props.per_id_capacities);
      const len = pipeMinMax(props.per_id_lengths);
      const fre = pipeMinMax(props.per_id_freespeeds);
      const vol = useSourceVolumes ? pipeMinMax(props.per_id_daily_avgs) : { min: null, max: null };

      // matchedIds sorted in place → link_ids + link_key_join match the previous
      // (mutating) behaviour; links/leftIds/rightIds were built before this.
      matchedIds.sort();
      // Identity used for click + highlight matching. A link with no matched
      // ids falls back to its own, otherwise every unserved feature would share
      // an empty key and clicking one would select all of them at once.
      const identityIds = matchedIds.length ? matchedIds : keys.map(String).sort();

      const invariant = {
        ...f.properties,
        // Bearing for the split offset + direction labels (derive if absent).
        angle: computeAngle(f),

        // full-day totals + directional split (window-independent)
        total_volume: totalAllBins,
        total_left: totalLeft,
        total_right: totalRight,

        // Matched pt ids per direction — consumed by buildSplitFeatures so the
        // split overlay's ls_link_ids only ever carry transit links.
        right_ids: rightIds.join("|"),
        left_ids: leftIds.join("|"),

        // min/max for filtering (default 0 when empty, matching the old fallthrough)
        capacity_min: cap.min ?? 0,
        capacity_max: cap.max ?? 0,
        length_min: len.min ?? 0,
        length_max: len.max ?? 0,
        freespeed_min: fre.min ?? 0,
        freespeed_max: fre.max ?? 0,
        volume_min: vol.min ?? 0,
        volume_max: vol.max ?? 0,

        // filtering & sidebar
        modes: Array.from(modesUnion),
        lines: mergedLines,
        line_ids: Object.keys(mergedLines),
        line_ids_h: lineIdsH,
        line_ids_r: lineIdsR,
        link_ids: identityIds,
        link_key_join: identityIds.join(","),
      };

      prepared.push({ f, links, invariant });
    }

    return prepared;
  }

  // Per-interaction recompute (run on every time / line / direction change).
  // Only the windowed directional sums vary, so this reuses the prepared
  // invariant props + the volume index and never re-parses / re-merges. Output
  // feature shape is identical to the old computeFilteredFeatures.
  function recomputeWindows(prepared, volumeById, timeRange, filterLineId, direction) {
    const startTick = timeRange?.[0] ?? 0;
    const endTick = timeRange?.[1] ?? 96;
    const isFullDay = startTick === 0 && endTick === 96;

    // Route-direction (.H/.R) filter — only meaningful with a line selected.
    // Lines without direction data (CDN files) keep their total bins so the
    // filter stays inert on legacy data.
    const dirLetter = filterLineId ? directionLetter(direction) : null;
    const lineWindowBins = (line) => {
      if (dirLetter && line?.directions) return line.directions[dirLetter] || {};
      return line?.timeBins || {};
    };
    const lineFullTotal = (line) => {
      if (dirLetter && line?.directions) {
        const bins = line.directions[dirLetter] || {};
        return Object.values(bins).reduce((a, v) => a + (Number(v) || 0), 0);
      }
      return Number(line?.total) || 0;
    };

    const features = [];

    for (const p of prepared) {
      let windowSum = 0, left = 0, right = 0;

      for (const { id, arrow } of p.links) {
        const entry = volumeById[id];
        if (!entry) continue;
        const allLines = entry.lines; // { lineId: { timeBins, directions, total, mode } }

        // Which lines contribute to the window? (selected line if set)
        const activeLines = filterLineId
          ? (allLines[filterLineId] ? { [filterLineId]: allLines[filterLineId] } : null)
          : allLines;
        if (!activeLines) continue; // line not on this link → contributes 0

        let thisWindow = 0;
        if (isFullDay) {
          for (const lid in activeLines) thisWindow += lineFullTotal(activeLines[lid]);
        } else {
          for (const lid in activeLines) {
            const tb = lineWindowBins(activeLines[lid]);
            for (let tick = startTick; tick < endTick; tick++) {
              thisWindow += Number(tb[tickKey(tick)]) || 0;
            }
          }
        }
        windowSum += thisWindow;

        if (arrow === "←") left += thisWindow;
        else if (arrow === "→") right += thisWindow;
        else { left += thisWindow / 2; right += thisWindow / 2; } // arrow missing → split evenly
      }

      // Filtered selection shows only the highlighted line's mode; unfiltered
      // keeps the segment's full mode union (both precomputed in prepare).
      const filteredMode = filterLineId ? p.invariant.lines[filterLineId]?.mode : null;
      const modes = filterLineId
        ? (filteredMode ? [String(filteredMode)] : [])
        : p.invariant.modes;

      features.push({
        ...p.f,
        properties: {
          ...p.invariant,
          // color/width use "daily_avg_volume" of the current window (road-style)
          daily_avg_volume: left + right,
          left_sum: left,
          right_sum: right,
          filtered_volume: windowSum,
          modes,
        },
      });
    }

    return features;
  }

  // Stage-1 features: the PT-capable network, drawn before the volume payload
  // lands. Same shape recomputeWindows emits, with every volume-derived number
  // zeroed — so the layers, the split overlay, clicking and the feature table
  // all work immediately and only the numbers are missing. Volumes then replace
  // this wholesale (the served links are a subset of these, see transitLinks.js).
  function buildPendingFeatures(features, hasSourceVolumes) {
    const out = [];
    for (const f of features) {
      const props = f.properties || {};
      const keys = parsePipeList(props.per_id_keys);
      if (!keys.length) continue;

      const cap = pipeMinMax(props.per_id_capacities);
      const len = pipeMinMax(props.per_id_lengths);
      const fre = pipeMinMax(props.per_id_freespeeds);
      const vol = hasSourceVolumes ? pipeMinMax(props.per_id_daily_avgs) : { min: null, max: null };
      // Array form, matching the invariant's `modes` — the mode filter and the
      // module's boundary aggregate both accept either, but staying consistent
      // across the two stages keeps `["in", mode, ["get","modes"]]` exact.
      const modes = Array.isArray(props.modes)
        ? props.modes
        : String(props.modes || "").split(",").map((m) => m.trim()).filter(Boolean);
      const ids = keys.slice().sort();

      out.push({
        ...f,
        properties: {
          ...props,
          angle: computeAngle(f),
          modes,
          // Volume-derived, unknown until stage 2.
          total_volume: 0,
          total_left: 0,
          total_right: 0,
          daily_avg_volume: 0,
          left_sum: 0,
          right_sum: 0,
          filtered_volume: 0,
          capacity_min: cap.min ?? 0,
          capacity_max: cap.max ?? 0,
          length_min: len.min ?? 0,
          length_max: len.max ?? 0,
          freespeed_min: fre.min ?? 0,
          freespeed_max: fre.max ?? 0,
          volume_min: vol.min ?? 0,
          volume_max: vol.max ?? 0,
          link_ids: ids,
          link_key_join: ids.join(","),
        },
      });
    }
    return out;
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
      removeTerminusMarker(map);

      // Clear network-highlight instead of removing it (shared with network)
      clearNetworkHighlightData(map);

      setSelectedTransitLink(null);
      setTransitVolumesByLink(null);
      setDetailReady(false);
      setDetailPending?.(false);
      // Own the spinner's *off* switch as well as its on switch. Teardown runs
      // on module exit, which can land while a stage is still in flight — the
      // in-flight run then bails on its superseded check and would otherwise
      // leave "Loading network..." on screen over whatever the user switched to.
      setIsLoading(false);
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

    // Create the sources + layers for a feature set. Called once, from stage 1 —
    // stage 2 only swaps the data in and repaints, so the map never flickers
    // between the two.
    const createLayers = (features, pending) => {
      map.addSource("transit-volumes-source", {
        type: "geojson",
        generateId: true,
        data: { type: "FeatureCollection", features },
      });

      // Visible merged line layer — mirrors the road “Volumes” colour ramp
      // (daily_avg_volume). Shown only below SPLIT_ZOOM (capped further down).
      // While volumes are pending every feature reads 0, which the ramp would
      // paint a uniform pale green — indistinguishable from "this line really
      // carries nobody" — so it starts neutral grey and applyDetail() swaps in
      // the ramp when the numbers arrive.
      map.addLayer(
        {
          id: MERGED_LAYER_ID,
          type: "line",
          source: "transit-volumes-source",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": MERGED_RAMP,
            "line-width": pending ? PENDING_WIDTH_EXPR : MERGED_WIDTH_EXPR,
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
          paint: { "line-opacity": 0, "line-width": MERGED_HITBOX_WIDTH_EXPR },
        },
        MERGED_LAYER_ID
      );

      // Per-direction split overlay (offset lines) for zoom >= SPLIT_ZOOM,
      // built from the same features regrouped by direction.
      map.addSource(SPLIT_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: buildSplitFeatures(features) },
      });

      map.addLayer({
        id: SPLIT_LAYER_ID,
        type: "line",
        source: SPLIT_SOURCE_ID,
        minzoom: SPLIT_ZOOM,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": VOLUME_RAMP,
          "line-width": pending ? PENDING_WIDTH_EXPR : WIDTH_EXPR,
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
      // Their text is "" while ns_volume is 0, so nothing is drawn until the
      // volumes land — no special casing needed for the pending stage.
      addLabelLayersIfMissing();

      // Hand off merged ↔ split: merged only below SPLIT_ZOOM, split overlay
      // only at/above it (its minzoom). Prevents the merged line drawing under
      // the offset pair.
      if (map.getLayer(MERGED_LAYER_ID)) map.setLayerZoomRange(MERGED_LAYER_ID, 0, SPLIT_ZOOM);

      // Mode filter applies to every line/hitbox/label layer. The line filter is
      // deliberately NOT applied here: line membership is volume-derived, so
      // while pending it would match nothing and blank the map (see the filter
      // effects, which gate the line clause on detailReady).
      if (selectedTransitModes && !selectedTransitModes.includes("all")) {
        applyLayerFilters(map, [
          "any",
          ...selectedTransitModes.map((mode) => ["in", mode, ["get", "modes"]]),
        ]);
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
    };

    // Stage 2 landed: swap the volume-bearing features in and turn the ramp on.
    // Reads the LIVE time window / line / direction (via refs) rather than the
    // values captured when init started, because the user can have moved all
    // three while the payload was in flight.
    const applyDetail = ({ volumeById, prepared }) => {
      const features = recomputeWindows(
        prepared, volumeById,
        timeRangeRef.current, highlightedLineIdRef.current, selectedDirectionRef.current
      );
      const splitFeatures = buildSplitFeatures(features);

      map.getSource("transit-volumes-source")?.setData({ type: "FeatureCollection", features });
      map.getSource(SPLIT_SOURCE_ID)?.setData({ type: "FeatureCollection", features: splitFeatures });
      setFeatureGeoJSON?.({ type: "FeatureCollection", features });

      // A link clicked during stage 1 was selected from a feature that carried
      // no volumes and no per-line breakdown, so re-select its volume-bearing
      // twin — otherwise the sidebar sits empty until the user clicks again.
      const matched = syncHighlights(map, features, splitFeatures);
      const refreshed = matched.split.length ? matched.split : matched.merged;
      if (refreshed.length) setSelectedTransitLink(refreshed.map((f) => f.properties));

      // Widths move off capacity and onto the volumes now that we have them;
      // the colour ramp was already live (reading 0) so it needs no swap.
      if (map.getLayer(MERGED_LAYER_ID)) {
        map.setPaintProperty(MERGED_LAYER_ID, "line-width", MERGED_WIDTH_EXPR);
      }
      if (map.getLayer(SPLIT_LAYER_ID)) {
        map.setPaintProperty(SPLIT_LAYER_ID, "line-width", WIDTH_EXPR);
      }
    };

    const init = async () => {
      removeLayers();
      const runId = ++runIdRef.current;
      const superseded = () => runId !== runIdRef.current;

      try {
        setIsLoading(true);
        setDetailReady(false);
        setDetailPending?.(true);

        // Wait out the sidebar-driven camera padding ease before doing anything
        // that blocks the main thread — see _lib/paddingGate.js. Resolves
        // immediately when no padding shift is in flight.
        await paddingSettled();
        if (superseded()) return;

        // ---- Stage 1: geometry only -------------------------------------
        // Same MATSim geometry the road modules render — PT volumes are keyed on
        // `network_links.link_id`, so this module only changes the symbology.
        // The shared loader fetches/merges/decorates it once per (dataset,
        // canton) and hands the same FeatureCollection to useNetworkLayers and
        // to us, so entering Transit Volumes after (or before) a network module
        // costs no download. It also does the CDN-format merge this hook used to
        // do inline (one feature per directed link, no per_id_* arrays).
        const networkGeo = await loadNetworkGeometry(loadWithFallback, datasetId, searchCanton);
        if (superseded()) return;
        if (!networkGeo?.features) {
          console.warn("No network geometry for transit volumes", searchCanton);
          setIsLoading(false);
          setDetailPending?.(false);
          return;
        }

        // Which links can carry transit is answerable from the geometry alone,
        // so draw them now instead of waiting on the volume payload. Verified
        // against the duckdb: this misses none of the links that carry service
        // and over-selects by ~1.5×; the extras vanish when stage 2 replaces
        // the feature set with the served subset.
        const hasSourceVolumes = networkGeo.sourceHasDailyAvgs !== false;
        const transitFeatures = filterTransitFeatures(networkGeo.features);
        const pendingFeatures = buildPendingFeatures(transitFeatures, hasSourceVolumes);
        createLayers(pendingFeatures, true);
        setFeatureGeoJSON?.({ type: "FeatureCollection", features: pendingFeatures });

        // ---- Stage 2: the volume payload --------------------------------
        // Cached per (dataset, canton) so re-entering the module never redoes
        // any of this. `prepare` runs only on a cache miss.
        const bundle = await loadPtVolumeBundle(
          loadWithFallback, datasetId, searchCanton,
          (volumeJSON) => {
            const volumeById = normalizeVolumeIndex(
              toVolumeById(volumeJSON), Array.isArray(volumeJSON)
            );
            return {
              volumeById,
              prepared: prepareFeatures(transitFeatures, volumeById, hasSourceVolumes),
            };
          }
        );
        if (superseded()) return;
        if (!bundle) {
          console.warn("No transit volume data for", searchCanton);
          setDetailPending?.(false);
          return;
        }

        originalGeoJSON.current = { geo: networkGeo, ...bundle };
        setTransitVolumesByLink(bundle.volumeById);
        applyDetail(bundle);
        setDetailReady(true);
        setDetailPending?.(false);
      } catch (err) {
        console.warn("Failed to load transit volumes layer", err);
        if (!superseded()) {
          setIsLoading(false);
          setDetailPending?.(false);
        }
      }
    };

    init();
    return () => {
      // Invalidate any in-flight stage so a late resolution can't paint over
      // the module the user has since switched to.
      runIdRef.current++;
      removeLayers();
    };
  }, [isGraphExpanded, searchCanton, datasetId]);

  // ----- update data on timeRange change -------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || isGraphExpanded !== "TransitVolumes" || !originalGeoJSON.current) return;

    const { volumeById, prepared } = originalGeoJSON.current;
    // A ref left over from an older code shape (e.g. after an HMR swap that
    // preserved this ref) can be truthy but lack `prepared`. Bail until the init
    // effect repopulates it rather than crashing recomputeWindows on undefined.
    if (!prepared || !volumeById) return;
    const updatedFeatures = recomputeWindows(prepared, volumeById, timeRange, highlightedLineId, selectedDirection);

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

    // Keep both highlight sources pointing at the recomputed features.
    syncHighlights(map, updatedFeatures, splitFeatures);

    // Also update the table GeoJSON so filteredVolume shows correct values
    setFeatureGeoJSON?.({ type: "FeatureCollection", features: updatedFeatures });
  }, [timeRange, highlightedLineId, selectedDirection]);

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

    // 2) Build the optional "only this line" filter. With a route-direction
    // (.H/.R) active, match against that direction's line membership so
    // segments the line only serves in the other direction drop out.
    // Skipped until the volume data lands: line membership comes from it, so a
    // line filter over the stage-1 features would match nothing and blank the
    // map. detailReady is a dep, so the filter is applied as soon as it does.
    const lineFilter = buildLineFilter(highlightedLineId, selectedDirection, detailReady);

    // 3) Combine them
    const combinedFilter =
      lineFilter && modeFilter
        ? ["all", lineFilter, modeFilter]
        : lineFilter || modeFilter || null;

    // Apply to merged + split line/hitbox layers and the direction labels.
    applyLayerFilters(map, combinedFilter);
  }, [selectedTransitModes, highlightedLineId, isGraphExpanded, selectedDirection, detailReady]);

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

    // 2) Build the line filter (direction-aware, same as the effect above)
    const lineFilter = buildLineFilter(highlightedLineId, selectedDirection, detailReady);

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
  }, [selectedTransitModes, highlightedLineId, isGraphExpanded, tableFilterQuery, selectedDirection, detailReady]);

  // ----- direction terminus marker -------------------------------------------
  // With a line highlighted and a direction (outbound/return) selected, mark the
  // selected direction's terminus stop (red dot + label) so the travel direction
  // reads straight off the map — same marker as the Transit Stops module. The
  // stop's coord + name come from route_directions.json (routeDirections); on
  // legacy datasets without that asset there's no coord, so no marker is drawn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isGraphExpanded !== "TransitVolumes") {
      removeTerminusMarker(map);
      return;
    }

    removeTerminusMarker(map);

    const dirLetter = highlightedLineId ? directionLetter(selectedDirection) : null;
    if (!dirLetter) return;

    const info = routeDirections?.[highlightedLineId] || null;
    const endInfo = dirLetter === "H" ? info?.H : info?.R;
    const end = endInfo?.coord;
    if (!end) return;

    // Gate on the line actually being served in this direction within the loaded
    // canton — the terminus in route_directions.json is line-global, so without
    // this a red dot could appear for a direction whose segments are all filtered
    // out here (the line only runs the other way in this canton). Mirrors how the
    // Transit Stops marker (useTransitLines) is tied to the drawn route geometry.
    // Read the per-direction line membership off the prepared invariant props
    // (the same data the map source is built from) rather than mapbox's private
    // GeoJSONSource._data, whose presence/shape isn't guaranteed.
    const lineProp = dirLetter === "H" ? "line_ids_h" : "line_ids_r";
    const prepared = originalGeoJSON.current?.prepared || [];
    const servesHere = prepared.some((p) =>
      (p?.invariant?.[lineProp] || []).includes(highlightedLineId)
    );
    if (!servesHere) return;

    const endName = endInfo?.terminus || "Terminus";
    const drawMarker = () => {
      map.addSource(TERMINUS_SOURCE, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: end }, properties: { name: endName } },
          ],
        },
      });
      map.addLayer({
        id: "transit-volumes-terminus-circle",
        type: "circle",
        source: TERMINUS_SOURCE,
        paint: {
          "circle-radius": 7,
          "circle-color": "#ef4444",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "transit-volumes-terminus-label",
        type: "symbol",
        source: TERMINUS_SOURCE,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-offset": [0, -1.1],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#b91c1c",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
    };

    // Draw immediately: addSource/addLayer only need the style's initial load,
    // NOT a fully-settled style. The old `if (!map.isStyleLoaded()) return;`
    // guard bailed whenever the style had pending changes — which is the NORMAL
    // state right here, because the sibling effects (setData + applyLayerFilters)
    // dirty the style in the same commit when a direction is toggled. That made
    // the marker silently never appear on the very interaction that needs it.
    // Only a genuine mid-setStyle reload throws; retry that once on idle.
    try {
      drawMarker();
    } catch {
      const retry = () => {
        removeTerminusMarker(map);
        try { drawMarker(); } catch (err) {
          console.warn("Failed to add transit-volumes terminus marker", err);
        }
      };
      map.once("idle", retry);
      return () => map.off("idle", retry);
    }
    // datasetId: re-evaluate on dataset switch. routeDirections: draw/relabel
    // once the async route_directions.json resolves. detailReady: the
    // serves-here test reads `prepared`, which only exists after stage 2.
  }, [isGraphExpanded, highlightedLineId, selectedDirection, routeDirections, datasetId, detailReady]);

}
