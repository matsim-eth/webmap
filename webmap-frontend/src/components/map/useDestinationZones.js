import { useEffect, useRef } from 'react';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useMap } from '../../context/MapContext';
import {
    safeRemoveLayer,
    safeRemoveSource,
    setOrAddSource,
    addLayerOnce,
    onLayer,
} from './_lib/mapbox';
// Precomputed inside-polygon centroids (turf.pointOnFeature). Regenerate from
// the canton GeoJSON if the polygon set ever changes.
import cantonCentroids from '../../utils/cantonCentroids.json';
import { computeMapPadding } from '../sidebar/sidebarLayout';

// Convert a flat study-area bbox [minLon,minLat,maxLon,maxLat] into the
// [[sw],[ne]] form mapbox fitBounds expects — used to fit-bounds back out to
// the whole study area after the initial zoom-into-canton animation.
const toBoundsPair = (b) =>
    (Array.isArray(b) && b.length === 4) ? [[b[0], b[1]], [b[2], b[3]]] : null;

// Each palette entry: solid hex for dots, plus the rgba() pair used for the
// along-line gradient (faint at origin → vivid at destination).
const MODE_PALETTE = {
    car:  { solid: '#636efa', faint: 'rgba(99,110,250,0.18)',  vivid: 'rgba(99,110,250,1)' },
    pt:   { solid: '#00cc96', faint: 'rgba(0,204,150,0.18)',   vivid: 'rgba(0,204,150,1)' },
    bike: { solid: '#ab63fa', faint: 'rgba(171,99,250,0.18)',  vivid: 'rgba(171,99,250,1)' },
    walk: { solid: '#ffa15a', faint: 'rgba(255,161,90,0.18)',  vivid: 'rgba(255,161,90,1)' },
    all:  { solid: '#1f77b4', faint: 'rgba(31,119,180,0.18)',  vivid: 'rgba(31,119,180,1)' },
};

// Purpose palette mirrors the dashboard (see ByDistanceStacked.jsx). A
// specific purpose wins over a specific mode for color so the user sees
// "purpose-filtered" flow in its dedicated hue.
const PURPOSE_PALETTE = {
    work:      { solid: '#FFEE8C', faint: 'rgba(255,238,140,0.18)', vivid: 'rgba(255,238,140,1)' },
    education: { solid: '#636efa', faint: 'rgba(99,110,250,0.18)',  vivid: 'rgba(99,110,250,1)' },
    shop:      { solid: '#ffa15a', faint: 'rgba(255,161,90,0.18)',  vivid: 'rgba(255,161,90,1)' },
    leisure:   { solid: '#00cc96', faint: 'rgba(0,204,150,0.18)',   vivid: 'rgba(0,204,150,1)' },
};

// Deep saturated orange — same hex for the hub marker and the selected-arc
// highlight so the active-focus palette is unified across the visualization.
const HUB_COLOR = '#ea580c';
const SELECTED_COLOR = HUB_COLOR;
const SELECTED_FAINT = 'rgba(234,88,12,0.18)';
const SELECTED_VIVID = 'rgba(234,88,12,1)';

const HUB_GLOW_SRC = 'destination-hub-glow-src';
const HUB_GLOW_LAYER = 'destination-hub-glow';
const HUB_DOT_LAYER = 'destination-hub-dot';
const HUB_DOT_RADIUS = 11;
const HUB_GLOW_RADIUS = 60;

const ARROWS_SRC = 'destination-arrows-src';
const ARROW_LINE_LAYER = 'destination-arrows-line';
const SELECTED_LINE_LAYER = 'destination-arrows-selected';

const DOTS_SRC = 'destination-dots-src';
const DOTS_LAYER = 'destination-dots';

const MODULE_SOURCES = [HUB_GLOW_SRC, ARROWS_SRC, DOTS_SRC];
const MODULE_LAYERS = [HUB_DOT_LAYER, DOTS_LAYER, SELECTED_LINE_LAYER, ARROW_LINE_LAYER, HUB_GLOW_LAYER];

// Stationary gradient stops: faint at origin (0), ramping to vivid at the
// destination (1). Used for both base arcs and the selected-arc overlay,
// parameterised by palette.
const gradientStops = (faint, vivid) => [
    'interpolate', ['linear'], ['line-progress'],
    0,    faint,
    0.55, faint,
    1,    vivid,
];

// Zone centers come from the study area (backend ships an inside-the-polygon
// point per zone, so this works for any zone set — e.g. municipalities); the
// static Swiss canton centroids remain as the fallback for legacy datasets.
const makeCentroidOf = (zoneByName) => (zone) =>
    zoneByName?.get?.(zone)?.center || cantonCentroids[zone] || null;

// Quadratic bezier sample. Returns N+1 points o → c → d.
const bezier = (o, c, d, N = 28) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        const x = u * u * o[0] + 2 * u * t * c[0] + t * t * d[0];
        const y = u * u * o[1] + 2 * u * t * c[1] + t * t * d[1];
        pts.push([x, y]);
    }
    return pts;
};

const removeAll = (map) => {
    safeRemoveLayer(map, MODULE_LAYERS);
    safeRemoveSource(map, MODULE_SOURCES);
};

// Build line + dot features. Lines always run "source → destination of flow",
// so in outflow the line goes clicked → other and in inflow it goes other →
// clicked. The line-gradient paint expression then naturally brightens
// toward the destination end regardless of direction.
const buildFeatures = (originCanton, perCanton, selectedMode, isOriginMode, centroidOf) => {
    const origin = centroidOf(originCanton);
    if (!origin) return { lines: [], dots: [] };

    const mode = selectedMode || 'all';
    const entries = Object.entries(perCanton)
        .map(([canton, data]) => [canton, Number(data?.[mode]) || 0])
        .filter(([canton, v]) => v > 0 && canton !== originCanton && centroidOf(canton));

    const total = entries.reduce((s, [, v]) => s + v, 0);

    const lines = [];
    const dots = [];

    entries.forEach(([canton, volume], i) => {
        const other = centroidOf(canton);
        // Lift the control point northward so every arc rises before
        // descending into its endpoint — gives the map an "airline route"
        // silhouette and prevents straight chords overlapping each other.
        const mx = (origin[0] + other[0]) / 2;
        const my = (origin[1] + other[1]) / 2;
        const dx = other[0] - origin[0];
        const dy = other[1] - origin[1];
        const chordLen = Math.hypot(dx, dy) || 1;
        const lift = 0.18 * chordLen;
        const control = [mx, my + lift];
        const samples = isOriginMode
            ? bezier(origin, control, other)
            : bezier(other, control, origin);

        const share = total > 0 ? volume / total : 0;
        const baseProps = {
            dz_canton: canton,
            dz_volume: volume,
            dz_share: share,
        };

        lines.push({
            type: 'Feature',
            id: i,
            geometry: { type: 'LineString', coordinates: samples },
            properties: baseProps,
        });

        // Dot at the "other" canton centroid in both modes — the periphery
        // of the hub-and-spoke layout.
        dots.push({
            type: 'Feature',
            id: i,
            geometry: { type: 'Point', coordinates: other },
            properties: baseProps,
        });
    });

    return { lines, dots };
};

export default function useDestinationZones({ mapRef, selectedDestinationData, isGraphExpanded }) {
    const { clickedCanton } = useSelection();
    const {
        studyArea, zoneByName,
        destinationHoveredCanton, setDestinationHoveredCanton,
        destinationSelectedCanton, setDestinationSelectedCanton,
    } = useData();
    const centroidOf = makeCentroidOf(zoneByName);
    const { isSidebarOpen, isLeftSidebarCollapsed } = useMap();

    // canton → feature id map, used by the hover/select effects.
    const cantonIdMapRef = useRef(new Map());

    // ── EFFECT 1: build / update layers when data changes ──
    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;

        const active = isGraphExpanded === 'Destination'
            && clickedCanton
            && selectedDestinationData?.perCanton;

        if (!active) {
            removeAll(map);
            cantonIdMapRef.current = new Map();
            return;
        }

        // Guard against stale data: clickedCanton updates synchronously but
        // selectedDestinationData lags one render behind (waiting on the
        // sidebar to recompute with the new canton's plotData). Skipping the
        // rebuild here keeps the previous origin's arcs on-screen until the
        // new data lands — avoids the "huge line between cantons" flash.
        if (selectedDestinationData.originCanton && selectedDestinationData.originCanton !== clickedCanton) {
            return;
        }

        const { perCanton, selectedMode, selectedPurpose, isOriginMode = true, sizingMode = 'volume' } = selectedDestinationData;
        const { lines, dots } = buildFeatures(clickedCanton, perCanton, selectedMode, isOriginMode, centroidOf);
        // Purpose color wins over mode if a specific purpose is selected.
        const palette = (selectedPurpose && selectedPurpose !== 'all' && PURPOSE_PALETTE[selectedPurpose])
            || MODE_PALETTE[selectedMode]
            || MODE_PALETTE.all;

        const hubCoord = centroidOf(clickedCanton);
        const hubFC = hubCoord
            ? { type: 'FeatureCollection', features: [{
                type: 'Feature',
                geometry: { type: 'Point', coordinates: hubCoord },
            }] }
            : { type: 'FeatureCollection', features: [] };
        const linesFC = { type: 'FeatureCollection', features: lines };
        const dotsFC = { type: 'FeatureCollection', features: dots };

        const nextMap = new Map();
        lines.forEach((f) => nextMap.set(f.properties.dz_canton, f.id));
        cantonIdMapRef.current = nextMap;

        // ── Sources ── ARROWS_SRC needs lineMetrics for line-progress gradient.
        setOrAddSource(map, HUB_GLOW_SRC, hubFC);
        setOrAddSource(map, ARROWS_SRC, linesFC, { lineMetrics: true });
        setOrAddSource(map, DOTS_SRC, dotsFC);

        // ── Expressions ──
        // Both width and dot radius derive from a single factor per mode.
        // Share curve is the original (decelerating past 50%). Volume
        // curve is more aggressive: small flows (≤100 trips) read as
        // hairlines and the top end runs past factor=1 so big
        // destinations dominate when sized by Volume.
        const factor = sizingMode === 'share'
            ? ['interpolate', ['linear'], ['get', 'dz_share'],
                0,    0,
                0.1,  0.10,
                0.25, 0.25,
                0.5,  0.50,
                0.75, 0.78,
                1,    1]
            : ['interpolate', ['linear'], ['sqrt', ['get', 'dz_volume']],
                0,     0,
                3.16,  0.015,  //    10 trips — hairline
                10,    0.06,   //   100 trips
                22.4,  0.165,  //   500 trips
                31.6,  0.285,  //   1K
                38.7,  0.375]; //   1.5K — practical max for this dataset
        const widthInterp = ['+', 1.5, ['*', factor, 55]];
        const widthCase = ['case',
            ['boolean', ['feature-state', 'hovered'], false], ['*', widthInterp, 1.4],
            widthInterp];

        // Dot radius derived from the same factor as line width so the two
        // channels stay in lockstep across the mode toggle.
        const dotRadius = ['+', 1.5, ['*', factor, 36]];
        const dotRadiusCase = ['case',
            ['boolean', ['feature-state', 'hovered'], false], ['*', dotRadius, 1.25],
            dotRadius];
        // Color: orange for the selected feature, otherwise the mode palette.
        const dotColorCase = ['case',
            ['boolean', ['feature-state', 'selected'], false], SELECTED_COLOR,
            palette.solid];

        // line-gradient brightens faint → vivid along line-progress 0 → 1.
        // Bezier samples are already oriented in flow direction, so this
        // works for both outflow and inflow.
        const lineGradient = gradientStops(palette.faint, palette.vivid);
        const selectedGradient = gradientStops(SELECTED_FAINT, SELECTED_VIVID);

        // Base arcs hide the selected feature so the orange overlay isn't
        // muddied; selected overlay matches only the selected feature.
        const baseLineFilter = destinationSelectedCanton
            ? ['!=', ['get', 'dz_canton'], destinationSelectedCanton]
            : true;
        const selectedFilter = destinationSelectedCanton
            ? ['==', ['get', 'dz_canton'], destinationSelectedCanton]
            : ['==', ['get', 'dz_canton'], '__none__'];

        // ── Layers (insertion order = paint order, bottom → top) ──
        // Hub glow and hub dot have only static paint, so addLayerOnce is
        // sufficient. The other three layers have dynamic paint that's
        // re-applied below.

        addLayerOnce(map, {
            id: HUB_GLOW_LAYER,
            type: 'circle',
            source: HUB_GLOW_SRC,
            paint: {
                'circle-color': HUB_COLOR,
                'circle-radius': HUB_GLOW_RADIUS,
                'circle-blur': 1.2,
                'circle-opacity': 0.35,
            },
        });

        addLayerOnce(map, {
            id: ARROW_LINE_LAYER,
            type: 'line',
            source: ARROWS_SRC,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            filter: baseLineFilter,
            paint: {
                'line-width': widthCase,
                'line-gradient': lineGradient,
                'line-opacity': 0.9,
            },
        });
        map.setFilter(ARROW_LINE_LAYER, baseLineFilter);
        map.setPaintProperty(ARROW_LINE_LAYER, 'line-width', widthCase);
        map.setPaintProperty(ARROW_LINE_LAYER, 'line-gradient', lineGradient);

        addLayerOnce(map, {
            id: SELECTED_LINE_LAYER,
            type: 'line',
            source: ARROWS_SRC,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            filter: selectedFilter,
            paint: {
                'line-gradient': selectedGradient,
                'line-width': widthCase,
                'line-opacity': 1,
            },
        });
        map.setFilter(SELECTED_LINE_LAYER, selectedFilter);
        map.setPaintProperty(SELECTED_LINE_LAYER, 'line-width', widthCase);
        map.setPaintProperty(SELECTED_LINE_LAYER, 'line-gradient', selectedGradient);

        addLayerOnce(map, {
            id: DOTS_LAYER,
            type: 'circle',
            source: DOTS_SRC,
            paint: {
                'circle-color': dotColorCase,
                'circle-radius': dotRadiusCase,
                'circle-opacity': 0.92,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        });
        map.setPaintProperty(DOTS_LAYER, 'circle-color', dotColorCase);
        map.setPaintProperty(DOTS_LAYER, 'circle-radius', dotRadiusCase);

        addLayerOnce(map, {
            id: HUB_DOT_LAYER,
            type: 'circle',
            source: HUB_GLOW_SRC,
            paint: {
                'circle-color': HUB_COLOR,
                'circle-radius': HUB_DOT_RADIUS,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 3,
            },
        });
    }, [mapRef, selectedDestinationData, isGraphExpanded, clickedCanton, destinationSelectedCanton, zoneByName]);

    // ── EFFECT 2: apply hovered + selected feature-state when they change ──
    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;
        if (!map.getSource(ARROWS_SRC)) return;

        for (const [canton, id] of cantonIdMapRef.current) {
            const hovered = canton === destinationHoveredCanton;
            const selected = canton === destinationSelectedCanton;
            map.setFeatureState({ source: ARROWS_SRC, id }, { hovered, selected });
            map.setFeatureState({ source: DOTS_SRC, id }, { hovered, selected });
        }
    }, [destinationHoveredCanton, destinationSelectedCanton, mapRef, selectedDestinationData]);

    // ── EFFECT 3b: zoom into canton then back out to full Switzerland ──
    // useCantons.js already kicks off a fitBounds-to-canton animation when
    // a canton is clicked (1 s duration). After that lands, pull back out
    // so the entire spider of arcs is in view. Padding mirrors the rules
    // useCantons applies — right grows when the destination sidebar is open,
    // left grows when the module sidebar is open.
    useEffect(() => {
        if (isGraphExpanded !== 'Destination') return;
        if (!clickedCanton) return;
        if (!mapRef.current) return;
        const map = mapRef.current;

        const ZOOM_IN_MS = 1000;     // matches the duration in useCantons
        const HOLD_MS = 250;         // brief pause at the canton before pulling back
        const ZOOM_OUT_MS = 1400;    // gentle pull-back

        // Same sidebar-compensated padding useCantons/usePadding apply, with
        // a slightly larger vertical margin for the arc spread.
        const padding = {
            ...computeMapPadding({
                isGraphExpanded: 'Destination',
                isSidebarOpen,
                isLeftSidebarOpen: !isLeftSidebarCollapsed,
            }),
            top: 60,
            bottom: 60,
        };

        const studyAreaBounds = toBoundsPair(studyArea?.bbox);
        const timer = setTimeout(() => {
            if (!studyAreaBounds) return;
            map.fitBounds(studyAreaBounds, {
                padding,
                duration: ZOOM_OUT_MS,
                essential: true,
            });
        }, ZOOM_IN_MS + HOLD_MS);

        return () => clearTimeout(timer);
    }, [clickedCanton, isGraphExpanded, mapRef, isSidebarOpen, isLeftSidebarCollapsed, studyArea]);

    // ── EFFECT 3: map → sidebar hover + click sync ──
    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;
        if (isGraphExpanded !== 'Destination') return;

        const onEnter = (e) => {
            const f = e.features?.[0];
            if (!f) return;
            map.getCanvas().style.cursor = 'pointer';
            setDestinationHoveredCanton(f.properties.dz_canton);
        };
        const onLeave = () => {
            map.getCanvas().style.cursor = '';
            setDestinationHoveredCanton(null);
        };
        const onClick = (e) => {
            const f = e.features?.[0];
            if (!f) return;
            // Stop the click from bubbling to the canton-fill layer, which
            // would otherwise reset the hub.
            e.preventDefault?.();
            const next = f.properties.dz_canton;
            setDestinationSelectedCanton((prev) => (prev === next ? null : next));
        };

        const layers = [DOTS_LAYER, ARROW_LINE_LAYER, SELECTED_LINE_LAYER];
        const cleanups = [];
        for (const id of layers) {
            cleanups.push(
                onLayer(map, 'mouseenter', id, onEnter),
                onLayer(map, 'mousemove', id, onEnter),
                onLayer(map, 'mouseleave', id, onLeave),
                onLayer(map, 'click', id, onClick),
            );
        }
        return () => cleanups.forEach((fn) => fn());
    }, [mapRef, isGraphExpanded, setDestinationHoveredCanton, setDestinationSelectedCanton]);

}
