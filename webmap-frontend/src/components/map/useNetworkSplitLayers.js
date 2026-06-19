import { useEffect, useRef, useCallback } from 'react';
import { nearestPointOnLine, lineString, point } from '@turf/turf';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useMap } from '../../context/MapContext';
import { safeRemoveLayer, safeRemoveSource, setVisibility } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

// LinkSpeeds-style "double link" rendering for the MATSim Network module: below
// SPLIT_ZOOM the shared base `network-layer` draws one merged line per segment
// (its existing colour/filter/selection machinery is untouched); at/above
// SPLIT_ZOOM that base layer is capped out and this overlay draws one offset
// line per direction, so a forward+reverse pair becomes two parallel lines that
// can be clicked individually. The merged-segment per_id_* arrays already carry
// everything we need, so no extra fetch — we just regroup them by direction.
//
// Handles 'Network' (freespeed colour, offsets, no labels) and 'Volumes'
// (per-direction volume colour + offset direction labels) through the same
// overlay; the two differ only in the split layer's colour expression and
// whether direction labels are drawn.

const SPLIT_ZOOM = 15;
const SPLIT_SOURCE_ID = 'network-split-source';
const SPLIT_LAYER_ID = 'network-split-layer';
const VOL_LABEL_RIGHT = 'network-split-label-right';
const VOL_LABEL_LEFT = 'network-split-label-left';
const BASE_LAYER_ID = 'network-layer';
// Base directional labels (useNetworkLayers, centred on the merged line) — hidden
// while Volumes split labels are active so the two don't double up.
const BASE_LABEL_IDS = ['network-label-left', 'network-label-right'];
const HIGHLIGHT_ID = 'network-highlight';

const RIGHT = '→'; // →
const LEFT = '←';  // ←

// Network freespeed ramp — identical to the base network-layer (useNetworkLayers),
// so the split lines look like the network they replace at high zoom.
const FREESPEED_RAMP = ['interpolate', ['linear'], ['get', 'freespeed'],
    0, '#ffffb2', 25, '#fed976', 50, '#feb24c', 75, '#fd8d3c',
    100, '#fc4e2a', 125, '#e31a1c', 150, '#b10026'];

// Volumes ramp on the per-direction windowed volume (`ns_volume`) — matches the
// base Volumes colour ramp so a segment's split lines keep the same scale.
const VOLUME_RAMP = ['interpolate', ['linear'], ['get', 'ns_volume'],
    0, '#ffffcc', 50, '#c2e699', 100, '#78c679', 250, '#31a354', 500, '#006837'];

const WIDTH_EXPR = ['interpolate', ['linear'], ['coalesce', ['get', 'capacity'], 1000], 300, 1, 4000, 8];

// Parallel-direction offset, same convention as useLinkSpeedsLayers: line-offset
// is perpendicular to drawing direction, so normalise by bearing (`angle`) to
// keep → visually on the right when the map is north-up.
const isWestish = ['any', ['>', ['get', 'angle'], 90], ['<=', ['get', 'angle'], -90]];
// Offset magnitude scales with capacity like the line width (WIDTH_EXPR: ~1..8px),
// so the two parallel direction lines keep a roughly constant gap instead of
// looking too far apart on thin links — but wide enough that each direction is
// separable/clickable on its own (a bit more than half the line width).
const OFFSET_MAG = ['interpolate', ['linear'], ['coalesce', ['get', 'capacity'], 1000], 300, 2.5, 4000, 7];
const OFFSET_NEG = ['*', -1, OFFSET_MAG];
const LINE_OFFSET_EXPR = ['case',
    ['!', ['get', 'ls_needs_offset']], 0,
    ['==', ['get', 'ls_arrow'], RIGHT],
        ['case', isWestish, OFFSET_NEG, OFFSET_MAG],
    ['case', isWestish, OFFSET_MAG, OFFSET_NEG],
];

// Direction-label text offset — same wide/normal scheme as useLinkSpeedsLayers so
// the number rides its own offset line (wider gap when both directions present).
const LABEL_OFFSET_NORMAL = 1;
const LABEL_OFFSET_WIDE = 1.6;
const LABEL_OFFSET_RIGHT = [0, ['case',
    ['get', 'ls_needs_offset'], ['case', isWestish, -LABEL_OFFSET_WIDE, LABEL_OFFSET_WIDE],
    ['case', isWestish, -LABEL_OFFSET_NORMAL, LABEL_OFFSET_NORMAL],
]];
const LABEL_OFFSET_LEFT = [0, ['case',
    ['get', 'ls_needs_offset'], ['case', isWestish, LABEL_OFFSET_WIDE, -LABEL_OFFSET_WIDE],
    ['case', isWestish, LABEL_OFFSET_NORMAL, -LABEL_OFFSET_NORMAL],
]];

// Regroup each merged segment's links by direction into per-direction features.
// Each split feature spreads the parent props (so modes/capacity/per_id_* and
// the freespeed colour all carry over) and sets `id = parent index` so every
// filter useFeatureSelectionFocus applies to the base layer applies here too.
function buildSplitFeatures(features) {
    const out = [];
    for (let idx = 0; idx < features.length; idx++) {
        const f = features[idx];
        const props = f.properties || {};
        const keys = parsePipeList(props.per_id_keys);
        if (!keys.length) continue;
        const arrows = parsePipeList(props.per_id_arrows);
        const right = [];
        const left = [];
        for (let i = 0; i < keys.length; i++) {
            (arrows[i] === LEFT ? left : right).push(keys[i]);
        }
        const needsOffset = right.length > 0 && left.length > 0;
        // Per-direction windowed volume for the Volumes colour ramp + labels.
        // right_sum/left_sum are kept time-window-current by useNetworkLayers
        // (→ = right_sum, ← = left_sum); harmless 0s in Network mode.
        const rightVol = Number(props.right_sum) || 0;
        const leftVol = Number(props.left_sum) || 0;
        const mk = (ids, arrow, vol) => ({
            type: 'Feature',
            id: idx,
            geometry: f.geometry,
            properties: {
                ...props,
                ls_arrow: arrow,
                ls_needs_offset: needsOffset,
                ls_link_ids: ids.join('|'),
                ns_volume: vol,
            },
        });
        if (right.length) out.push(mk(right, RIGHT, rightVol));
        if (left.length) out.push(mk(left, LEFT, leftVol));
    }
    return out;
}

export default function useNetworkSplitLayers({ mapRef, mapReady }) {
    const { isGraphExpanded } = useModule();
    const { featureGeoJSON } = useData();
    const { labelSize } = useMap();
    const {
        featureSelection,
        setFeatureSelection,
        setSelectedNetworkFeature,
        setNetworkSelectedLink,
        triggerVisualize,
    } = useSelection();

    // The modules this overlay treats as "split-capable".
    const isVolumes = isGraphExpanded === 'Volumes';
    const active = isGraphExpanded === 'Network' || isVolumes;

    // Track the last selected segment so the per-link dropdown resets to "All"
    // whenever a different segment is selected.
    const prevSelKeyRef = useRef(null);
    // The module the split layer/labels were last built for, so we recreate them
    // (different colour ramp; labels only in Volumes) on a Network↔Volumes switch.
    const builtModuleRef = useRef(null);

    const teardown = useCallback((map) => {
        safeRemoveLayer(map, [SPLIT_LAYER_ID, VOL_LABEL_RIGHT, VOL_LABEL_LEFT]);
        safeRemoveSource(map, [SPLIT_SOURCE_ID]);
        builtModuleRef.current = null;
        // Restore the base layer to all-zoom rendering + base directional labels.
        if (map.getLayer(BASE_LAYER_ID)) map.setLayerZoomRange(BASE_LAYER_ID, 0, 24);
        setVisibility(map, BASE_LABEL_IDS, true);
    }, []);

    // Build the Volumes direction-label layers (text rides each offset line).
    const addVolumeLabels = useCallback((map, size) => {
        const common = {
            'symbol-placement': 'line-center',
            'symbol-spacing': 9999999,
            'text-keep-upright': true,
            'text-size': size,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
        };
        const paint = { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.5 };
        if (!map.getLayer(VOL_LABEL_RIGHT)) {
            map.addLayer({
                id: VOL_LABEL_RIGHT, type: 'symbol', source: SPLIT_SOURCE_ID, minzoom: SPLIT_ZOOM,
                filter: ['==', ['get', 'ls_arrow'], RIGHT],
                layout: {
                    ...common,
                    // Blank when the direction carries no volume (matches base labels).
                    'text-field': ['case', ['==', ['round', ['get', 'ns_volume']], 0], '',
                        ['concat', ['to-string', ['round', ['get', 'ns_volume']]], ' →']],
                    'text-offset': LABEL_OFFSET_RIGHT,
                },
                paint,
            });
        }
        if (!map.getLayer(VOL_LABEL_LEFT)) {
            map.addLayer({
                id: VOL_LABEL_LEFT, type: 'symbol', source: SPLIT_SOURCE_ID, minzoom: SPLIT_ZOOM,
                filter: ['==', ['get', 'ls_arrow'], LEFT],
                layout: {
                    ...common,
                    'text-field': ['case', ['==', ['round', ['get', 'ns_volume']], 0], '',
                        ['concat', '← ', ['to-string', ['round', ['get', 'ns_volume']]]]],
                    'text-offset': LABEL_OFFSET_LEFT,
                },
                paint,
            });
        }
    }, []);

    // --- Build effect: split source/layer (+ Volumes labels) + base-layer handoff ---
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        if (!active) {
            teardown(map);
            setNetworkSelectedLink(null);
            prevSelKeyRef.current = null;
            return;
        }

        if (!featureGeoJSON?.features) {
            // Canton cleared / not loaded yet — drop the overlay so it can't show
            // stale geometry, but keep the module active.
            safeRemoveLayer(map, [SPLIT_LAYER_ID, VOL_LABEL_RIGHT, VOL_LABEL_LEFT]);
            safeRemoveSource(map, [SPLIT_SOURCE_ID]);
            builtModuleRef.current = null;
            return;
        }

        const fc = { type: 'FeatureCollection', features: buildSplitFeatures(featureGeoJSON.features) };
        const src = map.getSource(SPLIT_SOURCE_ID);
        if (src) {
            src.setData(fc);
        } else {
            map.addSource(SPLIT_SOURCE_ID, { type: 'geojson', data: fc });
        }

        // Network↔Volumes switch → different colour ramp (and labels) → recreate.
        if (builtModuleRef.current !== isGraphExpanded) {
            safeRemoveLayer(map, [SPLIT_LAYER_ID, VOL_LABEL_RIGHT, VOL_LABEL_LEFT]);
            builtModuleRef.current = isGraphExpanded;
        }

        if (!map.getLayer(SPLIT_LAYER_ID)) {
            map.addLayer({
                id: SPLIT_LAYER_ID,
                type: 'line',
                source: SPLIT_SOURCE_ID,
                minzoom: SPLIT_ZOOM,
                paint: {
                    'line-width': WIDTH_EXPR,
                    'line-color': isVolumes ? VOLUME_RAMP : FREESPEED_RAMP,
                    'line-opacity': 1,
                    'line-offset': LINE_OFFSET_EXPR,
                },
            });
        }

        if (isVolumes) {
            addVolumeLabels(map, Number(labelSize) || 11);
        }
        // Hide the base centred labels while the overlay is active: Volumes draws
        // its own offset split labels instead, and Network has no labels anyway.
        setVisibility(map, BASE_LABEL_IDS, false);

        // Hand off agg ↔ split: base layer only below SPLIT_ZOOM, overlay only
        // at/above it (its minzoom). Prevents the merged line drawing under the
        // offset pair.
        if (map.getLayer(BASE_LAYER_ID)) map.setLayerZoomRange(BASE_LAYER_ID, 0, SPLIT_ZOOM);
    }, [mapReady, mapRef, active, isVolumes, isGraphExpanded, featureGeoJSON, labelSize,
        teardown, addVolumeLabels, setNetworkSelectedLink]);

    // Volumes label size slider → update split label text-size in place.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;
        const size = Number(labelSize) || 11;
        [VOL_LABEL_RIGHT, VOL_LABEL_LEFT].forEach((id) => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'text-size', size);
        });
    }, [labelSize, mapReady, mapRef]);

    // --- Split-layer click: pick the clicked direction, select just its link(s) ---
    useEffect(() => {
        if (!mapReady || !mapRef.current || !active) return;
        const map = mapRef.current;

        // Both split features share one geometry, so queryRenderedFeatures returns
        // both — disambiguate by comparing the click's side to each feature's
        // paint-offset sign (same approach as useLinkSpeedsLayers).
        const pickByClickSide = (hits, clickLngLat) => {
            if (hits.length === 1) return hits[0];
            const ref = hits[0];
            if (!ref.properties.ls_needs_offset) return ref;
            const geom = ref.geometry;
            const coords = geom.type === 'LineString' ? geom.coordinates : geom.coordinates[0];
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
        };

        const onClick = (e) => {
            if (!e.features?.length) return;
            const clicked = pickByClickSide(e.features, e.lngLat);

            // Offset highlight for the single clicked direction (created before
            // setFeatureSelection so useFeatureSelectionFocus keeps this paint and
            // only refreshes the source).
            safeRemoveLayer(map, HIGHLIGHT_ID);
            safeRemoveSource(map, HIGHLIGHT_ID);
            map.addSource(HIGHLIGHT_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [clicked] } });
            map.addLayer({
                id: HIGHLIGHT_ID,
                type: 'line',
                source: HIGHLIGHT_ID,
                paint: {
                    'line-width': ['interpolate', ['linear'], ['coalesce', ['get', 'capacity'], 1000], 300, 6, 4000, 15],
                    'line-color': '#00a2ff',
                    'line-opacity': 1,
                    'line-offset': LINE_OFFSET_EXPR,
                },
            }, map.getLayer(SPLIT_LAYER_ID) ? SPLIT_LAYER_ID : BASE_LAYER_ID);

            setSelectedNetworkFeature([clicked.properties]);
            const g = clicked.geometry;
            const coords = g?.type === 'LineString' ? g.coordinates
                : g?.type === 'MultiLineString' ? g.coordinates.flat()
                : null;
            if (coords && setFeatureSelection) {
                setFeatureSelection({
                    id: clicked.properties.ls_link_ids,
                    feature: clicked,
                    coords,
                    fromMap: true,
                });
            }
        };
        const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
        const onLeave = () => { map.getCanvas().style.cursor = ''; };

        map.on('click', SPLIT_LAYER_ID, onClick);
        map.on('mouseenter', SPLIT_LAYER_ID, onEnter);
        map.on('mouseleave', SPLIT_LAYER_ID, onLeave);
        return () => {
            map.off('click', SPLIT_LAYER_ID, onClick);
            map.off('mouseenter', SPLIT_LAYER_ID, onEnter);
            map.off('mouseleave', SPLIT_LAYER_ID, onLeave);
        };
    }, [mapReady, mapRef, active, setFeatureSelection, setSelectedNetworkFeature]);

    // --- Reset the per-link dropdown to "All" whenever the selected segment
    // changes (keyed on ls_link_ids for a split click, per_id_keys for merged),
    // and clear any ant-line left over from a previous link's "Visualize". ---
    useEffect(() => {
        if (!active) return;
        const props = featureSelection?.feature?.properties;
        const selKey = props ? (props.ls_link_ids || props.per_id_keys || '') : null;
        if (selKey !== prevSelKeyRef.current) {
            prevSelKeyRef.current = selKey;
            setNetworkSelectedLink(null);
            triggerVisualize(null);
        }
    }, [active, featureSelection, setNetworkSelectedLink, triggerVisualize]);

    return null;
}
