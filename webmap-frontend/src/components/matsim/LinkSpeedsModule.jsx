import React, { useCallback, useMemo, useState } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { useData } from '../../context/DataContext';
import { useSelection } from '../../context/SelectionContext';
import { useFilters } from '../../context/FilterContext';
import { useModule } from '../../context/ModuleContext';
import { useMap } from '../../context/MapContext';
import { marks, formatTimeLabel } from '../../utils/timeSliderUtils';
import FeatureTable from '../table/FeatureTable';
import useLinePolygon from '../../hooks/useLinePolygon';
import useLinkSpeedsMapFilter from '../map/useLinkSpeedsMapFilter';
import { buildSelectionPayload, makeRowMatchesQuery } from '../table/_lib/rowSearch';
import '../Table.css';
import './VolumeFlowModule.css';

const METRIC_OPTIONS = [
    { value: 'congestion_index', label: 'Congestion Index' },
    { value: 'avg_speed', label: 'Avg Speed' },
    { value: 'freespeed', label: 'Freespeed' },
];

const ROAD_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential'];

// +/- toggle in the top-right of a `.canton-mode-share` card. Mirrors the
// pattern used by SegmentAttributesTable.
const CollapseToggle = ({ collapsed, onToggle }) => (
    <span
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(); }}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        style={{
            position: 'absolute',
            top: 8,
            right: 16,
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
            userSelect: 'none',
            color: 'var(--color-text-secondary)',
        }}
    >
        {collapsed ? '+' : '−'}
    </span>
);

const NUMERIC_COLS = new Set(['avgSpeed', 'freespeed', 'congestionIndex', 'dailyVolume']);

// Mirror the per-column render functions used in FeatureTable.jsx so JS-side
// substring matching agrees byte-for-byte with what DataTables shows in cells
// (otherwise "1,234" search hits the table but not the map, etc.).
const formatCell = (key, v) => {
    if (v == null) return key === 'modes' ? '-' : '';
    if (key === 'avgSpeed' || key === 'freespeed') return Number(v).toFixed(1);
    if (key === 'congestionIndex') return Number(v).toFixed(3);
    if (key === 'dailyVolume') return Number(v || 0).toLocaleString();
    if (key === 'modes') return String(v).replace(/,/g, ', ');
    return String(v);
};

const rowMatchesQuery = makeRowMatchesQuery({ numericCols: NUMERIC_COLS, formatCell });

const roundTo = (value, decimals = 0) => {
    if (!Number.isFinite(value)) return null;
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

// Build one row per underlying MATSim link (mirrors Network/Volumes table
// pattern, where each direction in per_id_keys becomes its own row).
const buildLinkSpeedsRows = (geojson, linksMap) => {
    if (!geojson?.features || !linksMap) return [];
    const rows = [];
    geojson.features.forEach((feature, featureIndex) => {
        const props = feature?.properties || {};
        const keys = (props.per_id_keys || '').split('|').filter(Boolean);
        const arrows = (props.per_id_arrows || '').split('|').filter(Boolean);
        if (!keys.length) return;

        const g = feature?.geometry;
        const coords = g?.type === 'LineString' ? g.coordinates
            : g?.type === 'MultiLineString' ? g.coordinates.flat()
            : null;
        const modes = props.modes || '';

        keys.forEach((k, i) => {
            const d = linksMap[k];
            if (!d || !d.volume || d.avg_speed == null || !d.freespeed) return;
            const arrow = arrows[i] || '';
            const avgSpeed = roundTo(d.avg_speed, 2);
            const freespeed = roundTo(d.freespeed, 2);
            const congestionIndex = d.freespeed
                ? roundTo(d.avg_speed / d.freespeed, 4)
                : null;
            const dailyVolume = Math.round(d.volume);

            rows.push({
                rowKey: `linkspeeds-${featureIndex}-${k}`,
                tableId: featureIndex,
                linkId: k,
                arrow,
                avgSpeed,
                freespeed,
                congestionIndex,
                dailyVolume,
                modes,
                // Use rendered values so DataTables' hidden-column "All columns"
                // search and rowMatchesQuery's JS substring agree.
                searchString: [
                    k,
                    arrow,
                    formatCell('avgSpeed', avgSpeed),
                    formatCell('freespeed', freespeed),
                    formatCell('congestionIndex', congestionIndex),
                    formatCell('dailyVolume', dailyVolume),
                    formatCell('modes', modes),
                ].join('|').toLowerCase(),
                coords,
                feature,
                featureProps: props,
            });
        });
    });
    return rows;
};

const LinkSpeedsModule = ({ featureTableRef }) => {
    const {
        featureGeoJSON,
        linkSpeedsLinksMap,
        linkSpeedsSummary,
        tableFilterQuery,
        isFeatureTableOpen,
        setTableFilterQuery,
        zoneLabel,
    } = useData();
    const {
        clickedCanton,
        linkSpeedsSelected,
        setFeatureSelection,
        setSelectedNetworkFeature,
        linkSpeedsSelectedLink,
        setLinkSpeedsSelectedLink,
    } = useSelection();
    const {
        timeRange, setTimeRange,
        linkSpeedsMetric, setLinkSpeedsMetric,
        linkSpeedsRoadTypes, setLinkSpeedsRoadTypes,
    } = useFilters();
    const { isGraphExpanded } = useModule();
    const { mapRef, drawRef } = useMap();

    const [isSummaryCollapsed, setIsSummaryCollapsed] = useState(false);
    const [isSelectedCollapsed, setIsSelectedCollapsed] = useState(false);
    const [isPolygonCollapsed, setIsPolygonCollapsed] = useState(false);

    const handleRoadTypeChange = (event) => {
        const selected = Array.from(event.target.selectedOptions).map(o => o.value);
        if (selected.includes('all') || selected.length === 0) {
            setLinkSpeedsRoadTypes(['all']);
        } else {
            setLinkSpeedsRoadTypes(selected);
        }
    };

    const handlePolygonChange = useCallback(() => {
        setSelectedNetworkFeature?.(null);
    }, [setSelectedNetworkFeature]);

    // Note: fading via feature-state isn't wired for link-speeds sources (they
    // hold derived agg/split features, not canton features indexed by position).
    // Polygon selection still drives the table filter + aggregate card below.
    const polygonFeatures = useLinePolygon({
        mapRef,
        drawRef,
        featureGeoJSON,
        isGraphExpanded,
        activeModule: 'LinkSpeeds',
        sourceId: 'link-speeds-source',
        layerIds: [],
        labelLayerIds: [],
        onPolygonChange: handlePolygonChange,
    });

    const polygonFeaturesSet = useMemo(() => new Set(polygonFeatures), [polygonFeatures]);

    // Build rows from featureGeoJSON + linksMap (same aggregation as the map layer).
    const tableRows = useMemo(
        () => buildLinkSpeedsRows(featureGeoJSON, linkSpeedsLinksMap),
        [featureGeoJSON, linkSpeedsLinksMap]
    );

    // Polygon-restricted rows (the user-visible table starts from these).
    const polygonRows = useMemo(() => {
        if (!polygonFeatures.length) return tableRows;
        return tableRows.filter(row => polygonFeaturesSet.has(row.feature));
    }, [tableRows, polygonFeatures.length, polygonFeaturesSet]);

    // Intersect polygon-rows with the table search query → produce two sets:
    //   visibleSegmentKeys — segment `per_id_keys` strings (full agg key per
    //                        segment) used to filter the agg layer at low zoom.
    //   visibleSplitIds    — per-direction `ls_link_ids` strings (one per
    //                        surviving direction) used for the split layer +
    //                        labels at high zoom. Built by partitioning each
    //                        segment's surviving rows by arrow → joined.
    // null on either = clear that layer's filter; empty set = hide everything.
    const { visibleSegmentKeys, visibleSplitIds } = useMemo(() => {
        const polyActive = polygonFeatures.length > 0;
        const queryActive = !!(tableFilterQuery && tableFilterQuery.value);
        if (!polyActive && !queryActive) {
            return { visibleSegmentKeys: null, visibleSplitIds: null };
        }
        const segmentSet = new Set();
        // bucket per segment: { '→': [linkIds], '←': [linkIds] }
        const perSegment = new Map();
        for (const row of polygonRows) {
            if (queryActive && !rowMatchesQuery(row, tableFilterQuery)) continue;
            const segKey = row.featureProps?.per_id_keys;
            if (!segKey) continue;
            segmentSet.add(segKey);
            let buckets = perSegment.get(segKey);
            if (!buckets) {
                buckets = { '→': [], '←': [] };
                perSegment.set(segKey, buckets);
            }
            const arr = buckets[row.arrow];
            if (arr) arr.push(row.linkId);
        }
        // Build the per-direction joined ids the same way useLinkSpeedsLayers
        // does: `[...right.ids, ...left.ids].join('|')` for the agg, or
        // `p.ids.join('|')` for each direction.
        const splitSet = new Set();
        for (const buckets of perSegment.values()) {
            if (buckets['→'].length) splitSet.add(buckets['→'].join('|'));
            if (buckets['←'].length) splitSet.add(buckets['←'].join('|'));
        }
        return { visibleSegmentKeys: segmentSet, visibleSplitIds: splitSet };
    }, [polygonRows, polygonFeatures.length, tableFilterQuery]);

    useLinkSpeedsMapFilter({
        mapRef,
        isGraphExpanded,
        visibleSegmentKeys,
        visibleSplitIds,
        isFeatureTableOpen,
        clickedCanton,
        setTableFilterQuery,
    });

    // Rows passed to the FeatureTable — DataTables handles its own internal
    // search across these, but we still hand it the polygon-pre-filtered set.
    const activeTableRows = polygonRows;

    // Polygon aggregate summary (volume-weighted, like buildAll).
    const polygonAggregate = useMemo(() => {
        if (!polygonFeatures.length || !linkSpeedsLinksMap) return null;
        const allModes = new Set();
        let vsum = 0, fsum = 0, volsum = 0;
        let linkCount = 0;
        const allLinkIds = [];
        for (const f of polygonFeatures) {
            const props = f.properties || {};
            (props.modes || '').split(',').filter(Boolean).forEach(m => allModes.add(m));
            const keys = (props.per_id_keys || '').split('|').filter(Boolean);
            for (const k of keys) {
                const d = linkSpeedsLinksMap[k];
                if (d && d.volume && d.avg_speed != null && d.freespeed) {
                    vsum += d.avg_speed * d.volume;
                    fsum += d.freespeed * d.volume;
                    volsum += d.volume;
                    linkCount += 1;
                    allLinkIds.push(k);
                }
            }
        }
        if (!volsum) return null;
        const avg = vsum / volsum;
        const free = fsum / volsum;
        return {
            segmentCount: polygonFeatures.length,
            linkCount,
            avgSpeed: Number(avg.toFixed(2)),
            avgFreespeed: Number(free.toFixed(2)),
            congestionIndex: free ? Number((avg / free).toFixed(4)) : null,
            totalVolume: Math.round(volsum),
            modes: [...allModes],
            allLinkIds,
        };
    }, [polygonFeatures, linkSpeedsLinksMap]);

    // Mirrors Network/Volumes: setSelectedNetworkFeature feeds the sidebar
    // attribute panel; setFeatureSelection (= onFocusNetworkFeature) drives
    // the shared network-highlight layer + zoom via useFeatureSelectionFocus.
    const handleRowClick = useCallback((row) => {
        if (!row) return;
        const featureProps = row.featureProps || row.feature?.properties;
        if (featureProps) {
            setSelectedNetworkFeature?.([featureProps]);
        }
        const payload = buildSelectionPayload(row);
        if (payload) {
            setFeatureSelection?.(payload);
        }
    }, [setFeatureSelection, setSelectedNetworkFeature]);

    const handleSelectCoords = useCallback((coords, row) => {
        if (!row) return;
        handleRowClick({ ...row, coords: coords || row.coords });
    }, [handleRowClick]);

    return (
        <div className="plot-container">
        {isFeatureTableOpen ? (
            <FeatureTable
                ref={featureTableRef}
                selectedGraph="LinkSpeeds"
                tableId="link-speeds-feature-table"
                rows={activeTableRows}
                onRowClick={handleRowClick}
                onSelectCoords={handleSelectCoords}
                height="55vh"
                useScroller
                loading={!linkSpeedsLinksMap}
                initialOrder={[[3, 'asc']]}
                setTableFilterQuery={setTableFilterQuery}
            />
        ) : (
            <>
            {/* Metric toggle */}
            <div className="flow-direction-toggle">
                {METRIC_OPTIONS.map(opt => (
                    <button
                        key={opt.value}
                        className={`flow-dir-btn${linkSpeedsMetric === opt.value ? ' active' : ''}`}
                        onClick={() => setLinkSpeedsMetric(opt.value)}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* Road type filter + time range — combined into one filter card,
                matching the Filter-by-Mode card from the transit modules. */}
            <div className="mode-filter-container">
                <label className="mode-filter-label">Filter by Road Type:</label>
                <select
                    multiple
                    value={linkSpeedsRoadTypes}
                    onChange={handleRoadTypeChange}
                    className="mode-filter-select"
                >
                    <option value="all">All</option>
                    {ROAD_TYPES.map(rt => (
                        <option key={rt} value={rt}>
                            {rt.charAt(0).toUpperCase() + rt.slice(1)}
                        </option>
                    ))}
                </select>

                <label className="mode-filter-label mode-filter-time-label">
                    Time: {formatTimeLabel(timeRange[0])} – {formatTimeLabel(timeRange[1])}
                </label>
                <div className="mode-filter-slider">
                    <Slider
                        range
                        min={0}
                        max={96}
                        step={1}
                        marks={marks}
                        value={timeRange}
                        onChange={(val) => setTimeRange(val)}
                        allowCross={false}
                    />
                </div>
            </div>

            {/* No-selection hint */}
            {!clickedCanton && (
                <div className="no-selection">
                    <p>No {zoneLabel.toLowerCase()} selected</p>
                    <p className="hint">Select a {zoneLabel.toLowerCase()} to load link speeds</p>
                </div>
            )}

            {/* Polygon aggregate — wins over canton summary / single-link panel */}
            {polygonAggregate ? (
                <div className="canton-mode-share" style={{ position: 'relative' }}>
                    <CollapseToggle collapsed={isPolygonCollapsed} onToggle={() => setIsPolygonCollapsed(v => !v)} />
                    <h4>Polygon Selection</h4>
                    {!isPolygonCollapsed && (
                    <table>
                        <tbody>
                            <tr><td><strong>Selected Segments</strong></td><td>{polygonAggregate.segmentCount}</td></tr>
                            <tr><td><strong>Links with traffic</strong></td><td>{polygonAggregate.linkCount.toLocaleString()}</td></tr>
                            <tr><td><strong>Avg Speed</strong></td><td>{polygonAggregate.avgSpeed.toFixed(1)} km/h</td></tr>
                            <tr><td><strong>Avg Freespeed</strong></td><td>{polygonAggregate.avgFreespeed.toFixed(1)} km/h</td></tr>
                            <tr><td><strong>Congestion Index</strong></td><td>{polygonAggregate.congestionIndex ?? '—'}</td></tr>
                            <tr><td><strong>Total Volume</strong></td><td>{polygonAggregate.totalVolume.toLocaleString()}</td></tr>
                            <tr>
                                <td><strong>Modes</strong></td>
                                <td>
                                    <div className="mode-badges">
                                        {polygonAggregate.modes.map(m => (
                                            <span className="mode-badge" key={m}>{m}</span>
                                        ))}
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    )}
                </div>
            ) : (
                <>
                {/* Canton-wide summary */}
                {clickedCanton && linkSpeedsSummary && (
                    <div className="canton-mode-share" style={{ position: 'relative' }}>
                        <CollapseToggle collapsed={isSummaryCollapsed} onToggle={() => setIsSummaryCollapsed(v => !v)} />
                        <h4>Network Summary</h4>
                        {!isSummaryCollapsed && (
                        <table>
                            <tbody>
                                <tr><td><strong>Links with traffic</strong></td><td>{linkSpeedsSummary.totalLinks.toLocaleString()}</td></tr>
                                <tr><td><strong>Avg Speed</strong></td><td>{linkSpeedsSummary.avgSpeed != null ? `${linkSpeedsSummary.avgSpeed.toFixed(1)} km/h` : '—'}</td></tr>
                                <tr><td><strong>Avg Freespeed</strong></td><td>{linkSpeedsSummary.avgFreespeed != null ? `${linkSpeedsSummary.avgFreespeed.toFixed(1)} km/h` : '—'}</td></tr>
                                <tr><td><strong>Congestion Index</strong></td><td>{linkSpeedsSummary.congestionIndex ?? '—'}</td></tr>
                                <tr><td><strong>Total Volume</strong></td><td>{linkSpeedsSummary.totalVolume.toLocaleString()}</td></tr>
                            </tbody>
                        </table>
                        )}
                    </div>
                )}

                {/* Per-link selector — only for a merged (single-line, low-zoom)
                    selection bundling more than one link. Split-layer (zoomed-in,
                    per-direction) selections already isolate one direction, so no
                    dropdown is offered there. */}
                {linkSpeedsSelected && !linkSpeedsSelected.isSplit
                    && linkSpeedsSelected.allKeys?.length > 1 && (
                    <div className="link-selector">
                        <label>Link ID:</label>
                        <select
                            value={linkSpeedsSelectedLink || ''}
                            onChange={(e) => setLinkSpeedsSelectedLink(e.target.value || null)}
                        >
                            <option value="">All ({linkSpeedsSelected.allKeys.length} links)</option>
                            {linkSpeedsSelected.allKeys.map(key => (
                                <option key={key} value={key}>{key}</option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Selected-link detail */}
                {linkSpeedsSelected && (
                    <div className="canton-mode-share" style={{ position: 'relative' }}>
                        <CollapseToggle collapsed={isSelectedCollapsed} onToggle={() => setIsSelectedCollapsed(v => !v)} />
                        <h4>Selected Link</h4>
                        {!isSelectedCollapsed && (
                        <table>
                            <tbody>
                                <tr><td><strong>Link IDs</strong></td><td style={{ wordBreak: 'break-all' }}>{linkSpeedsSelected.linkId}</td></tr>
                                <tr><td><strong>Avg Speed</strong></td><td>{linkSpeedsSelected.avgSpeed.toFixed(1)} km/h</td></tr>
                                <tr><td><strong>Freespeed</strong></td><td>{linkSpeedsSelected.freespeed.toFixed(1)} km/h</td></tr>
                                <tr><td><strong>Congestion Index</strong></td><td>{linkSpeedsSelected.congestionIndex.toFixed(3)}</td></tr>
                                <tr><td><strong>Daily Volume</strong></td><td>{linkSpeedsSelected.dailyVolume.toLocaleString()} veh/day</td></tr>
                                <tr>
                                    <td><strong>Modes</strong></td>
                                    <td>
                                        <div className="mode-badges">
                                            {(linkSpeedsSelected.modes || '').split(',').filter(Boolean).map(m => (
                                                <span className="mode-badge" key={m}>{m}</span>
                                            ))}
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        )}
                    </div>
                )}

                {clickedCanton && !linkSpeedsSelected && (
                    <p style={{ padding: '1rem', fontStyle: 'italic', color: '#9ca3af' }}>
                        Click a link on the map to see its speed details.
                    </p>
                )}
                </>
            )}
            </>
        )}
        </div>
    );
};

export default LinkSpeedsModule;
