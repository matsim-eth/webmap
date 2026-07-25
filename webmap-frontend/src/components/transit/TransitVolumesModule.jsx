import React, { useCallback, useMemo, useState } from "react";
import Plot from "react-plotly.js";
import TransitLinkAttributesTable from "./TransitLinkAttributesTable";
import TransitLinkHistogram from "./TransitLinkHistogram";
import DirectionToggle from "./DirectionToggle";
import { directionLetter } from "../../utils/directionUtils";
import useRouteDirections, { directionLabelsForLine } from "../../hooks/useRouteDirections";
import FeatureTable from "../table/FeatureTable";
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import useLinePolygon from "../../hooks/useLinePolygon";
import useDrawPolygons from "../../hooks/useDrawPolygons";
import { useTransitVolumeHighlightSync } from "../../hooks/useTransitVolumeHighlightSync";
import { useTransitVolumeLinkReset } from "../../hooks/useTransitVolumeLinkReset";
import { useResetDirectionOnLineChange } from "../../hooks/useResetDirectionOnLineChange";
import { computeBoundaryFlow } from "../../utils/boundaryFlow";
import { buildSelectionPayload } from "../table/_lib/rowSearch";
import { parsePipeList } from "../map/_lib/pipeProps";
import { lookupByName } from "../../utils/nameMatch";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useChoropleth } from "../../context/ChoroplethContext";
import { useModule } from "../../context/ModuleContext";
import { useMap } from "../../context/MapContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";

// Split-overlay source whose feature ids equal the parent feature's index in
// featureGeoJSON — useLinePolygon mirrors its inPolygon feature-states there so
// the zoom>=15 split lines/labels fade per-feature like the merged layer.
// Module-level constant keeps a stable reference across renders.
const TRANSIT_EXTRA_STATE_SOURCES = ['transit-volumes-split-source'];

const TransitVolumesModule = ({ transitFeatureTableRef }) => {
  const { dataURL, datasetId, isFeatureTableOpen, featureGeoJSON, setTableFilterQuery, transitVolumesByLink } = useData();
  const {
    selectedTransitModes, setSelectedTransitModes,
    showLineSymbology, setShowLineSymbology,
    timeRange, setTimeRange,
    selectedDirection, setSelectedDirection,
  } = useFilters();
  const {
    clickedCanton: canton,
    selectedTransitLink, setSelectedTransitLink,
    transitSelectedLink, setTransitSelectedLink,
    triggerVisualize,
    setFeatureSelection,
  } = useSelection();
  const { highlightedLineId, setHighlightedLineId } = useChoropleth();
  const { isGraphExpanded } = useModule();
  const { mapRef, drawRef, labelSize, setLabelSize } = useMap();
  const loadWithFallback = useLoadWithFallback(dataURL);

  const selectedGraph = isGraphExpanded;

  // Per-link selection derived from the current selection (mirrors VolumesModule).
  //   isSplit          — per-direction (zoomed-in) selection; no dropdown.
  //   allKeys          — every link across the selection (drives the dropdown).
  //   effectiveLinkIds — link ids charted by the histograms.
  //   attrLinkFilter   — links the attribute table shows (null = all / "All").
  const selProps = Array.isArray(selectedTransitLink) ? selectedTransitLink[0] : null;
  const isSplit = !!selProps?.ls_arrow;
  const allKeys = useMemo(() => {
    const s = new Set();
    (selectedTransitLink || []).forEach((p) => {
      const ids = Array.isArray(p.link_ids) && p.link_ids.length
        ? p.link_ids
        : parsePipeList(p.per_id_keys);
      ids.forEach((id) => s.add(String(id)));
    });
    return Array.from(s);
  }, [selectedTransitLink]);
  const effectiveLinkIds = useMemo(() => {
    if (isSplit) {
      const dir = parsePipeList(selProps?.ls_link_ids).map(String);
      const matched = new Set(allKeys);
      const inter = dir.filter((id) => matched.has(id));
      return inter.length ? inter : dir;
    }
    if (transitSelectedLink) return [String(transitSelectedLink)];
    return allKeys;
  }, [isSplit, selProps, transitSelectedLink, allKeys]);
  const attrLinkFilter = isSplit
    ? parsePipeList(selProps?.ls_link_ids)
    : (transitSelectedLink ? [transitSelectedLink] : null);

  // Reset the dropdown to "All" (and drop any stale ant-path) on a new selection.
  useTransitVolumeLinkReset({ selectedTransitLink, setTransitSelectedLink, triggerVisualize });

  // Per-canton transit mode list — drives the multi-select dropdown.
  // datasetId in the key: refetch when the dataset switches.
  const { data: transitModesByCanton = {} } = useQuery({
    queryKey: ['transit-modes-by-canton', datasetId, dataURL],
    queryFn: () => loadWithFallback("matsim/transit/transit_modes_by_canton.json"),
  });
  // clickedCanton is the polygon display NAME ('Zürich'); the modes map is keyed
  // by the registry's ASCII spelling ('Zurich'). Match accent/space-insensitively.
  const availableTransitModes = useMemo(
    () => (canton ? lookupByName(transitModesByCanton, canton) : null) || [],
    [canton, transitModesByCanton]
  );

  // Terminus names labelling the .H/.R direction filter for the selected line.
  const routeDirections = useRouteDirections();
  const directionLabels = directionLabelsForLine(routeDirections, highlightedLineId);

  // A different line's H/R point at different termini — reset the direction
  // filter whenever the highlighted line changes. In a hook (not a render-phase
  // ref compare) because setSelectedDirection targets FilterContext, an ancestor
  // provider — updating it during render warns "cannot update a component while
  // rendering a different component".
  useResetDirectionOnLineChange(highlightedLineId, selectedDirection, setSelectedDirection);

  // Reset highlightedLineId on canton change AND when the feature table opens.
  // Clearing on table-open lets row clicks happen with no line filter active,
  // so the resulting setFeatureGeoJSON cascade can't race with DataTables
  // (which previously crashed with Node.removeChild). See the hook for context.
  useTransitVolumeHighlightSync({ canton, isFeatureTableOpen, setHighlightedLineId });

  // Polygon selection
  const handlePolygonChange = useCallback(() => {
    setSelectedTransitLink?.(null);
    setHighlightedLineId?.(null);
  }, [setSelectedTransitLink, setHighlightedLineId]);

  const polygonFeatures = useLinePolygon({
    mapRef,
    drawRef,
    featureGeoJSON,
    isGraphExpanded,
    activeModule: 'TransitVolumes',
    sourceId: 'transit-volumes-source',
    // Include the split overlay so the polygon fade also dims it at zoom >= 15;
    // its per-feature states come from extraStateSourceIds (split feature ids
    // equal the parent index, so the mirrored states line up 1:1). The labels
    // ride the split source too.
    layerIds: ['transit-volumes-layer', 'transit-volumes-split-layer'],
    labelLayerIds: ['transit-volumes-label-left', 'transit-volumes-label-right'],
    onPolygonChange: handlePolygonChange,
    fadeOpacity: 0.05,
    extraStateSourceIds: TRANSIT_EXTRA_STATE_SOURCES,
  });

  const drawnPolygons = useDrawPolygons({
    mapRef,
    drawRef,
    isGraphExpanded,
    activeModule: 'TransitVolumes',
  });

  // Boundary aggregate: same longitude-based directionality as road volumes.
  // right_sum / left_sum on transit features are computed by
  // useTransitVolumesLayer for the active time window AND highlighted line,
  // so time + line filters are honored automatically.
  // Mode filter is applied at the segment level (skip segments where no
  // selected mode is present); per-mode directional split isn't available
  // in the current data shape.
  const modesActive = selectedTransitModes && !selectedTransitModes.includes('all') && selectedTransitModes.length > 0;
  const transitBoundaryFilter = useCallback((f) => {
    if (!modesActive) return true;
    const raw = f?.properties?.modes;
    const featureModes = Array.isArray(raw) ? raw
      : (typeof raw === 'string' ? raw.split(',').filter(Boolean) : []);
    return featureModes.some(m => selectedTransitModes.includes(m));
  }, [modesActive, selectedTransitModes]);

  const boundaryAggregate = useMemo(
    () => computeBoundaryFlow({
      polygonFeatures,
      drawnPolygons,
      featureFilter: transitBoundaryFilter,
    }),
    [polygonFeatures, drawnPolygons, timeRange, highlightedLineId, transitBoundaryFilter]
  );

  // Polygon aggregate: merge lines, modes, volumes from all selected features
  const polygonAggregate = useMemo(() => {
    if (!polygonFeatures.length) return null;

    const modesSet = new Set();
    const mergedLines = {};
    let totalVolume = 0;
    let filteredVolume = 0;

    const startTick = timeRange?.[0] ?? 0;
    const endTick = timeRange?.[1] ?? 96;

    for (const f of polygonFeatures) {
      const props = f.properties || {};

      // Modes
      const modes = Array.isArray(props.modes) ? props.modes
        : (typeof props.modes === 'string' ? props.modes.split(',').filter(Boolean) : []);
      modes.forEach(m => modesSet.add(m));

      // Volumes
      totalVolume += Number(props.total_volume) || 0;
      filteredVolume += Number(props.filtered_volume) || 0;

      // Lines
      const lines = props.lines || {};
      for (const [lineId, line] of Object.entries(lines)) {
        if (!mergedLines[lineId]) {
          mergedLines[lineId] = {
            timeBins: {},
            directions: null,
            line_name: line.line_name ?? null,
            mode: line.mode ?? null,
            total: 0,
          };
        }
        if (!mergedLines[lineId].line_name && line.line_name) mergedLines[lineId].line_name = line.line_name;
        if (!mergedLines[lineId].mode && line.mode) mergedLines[lineId].mode = line.mode;
        mergedLines[lineId].total += Number(line.total) || 0;

        const srcBins = line.timeBins || {};
        const dstBins = mergedLines[lineId].timeBins;
        for (const k in srcBins) dstBins[k] = (dstBins[k] ?? 0) + (Number(srcBins[k]) || 0);

        // Merge per-direction (.H/.R) bins when present (v2 backend data)
        if (line.directions) {
          const dstDirs = mergedLines[lineId].directions || (mergedLines[lineId].directions = {});
          for (const [d, bins] of Object.entries(line.directions)) {
            const dst = dstDirs[d] || (dstDirs[d] = {});
            for (const k in bins) dst[k] = (dst[k] ?? 0) + (Number(bins[k]) || 0);
          }
        }
      }
    }

    // Build aggregated properties for TransitLinkAttributesTable compatibility
    const aggregateProps = {
      link_ids: [],
      per_id_keys: '',
      modes: [...modesSet],
      lines: mergedLines,
      total_volume: totalVolume,
      filtered_volume: filteredVolume,
    };

    return {
      segmentCount: polygonFeatures.length,
      propertiesList: [aggregateProps],
      mergedLines,
      modesSet,
      totalVolume,
      filteredVolume,
      startTick,
      endTick,
    };
  }, [polygonFeatures, timeRange]);

  // Polygon aggregate histogram data — sum all lines' timeBins into 96 bins.
  // With a line + .H/.R direction selected, use that direction's bins.
  const polygonHistogramData = useMemo(() => {
    if (!polygonAggregate) return null;

    const values = new Array(96).fill(0);
    const lines = polygonAggregate.mergedLines;
    const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);
    const dirLetter = highlightedLineId ? directionLetter(selectedDirection) : null;

    for (const id of lineIds) {
      const line = lines[id];
      const bins = (dirLetter && line?.directions)
        ? (line.directions[dirLetter] || {})
        : (line?.timeBins || {});
      for (let h = 0; h < 96; h++) {
        const hour = String(Math.floor(h / 4)).padStart(2, '0');
        const minute = String((h % 4) * 15).padStart(2, '0');
        values[h] += Number(bins[`${hour}:${minute}`]) || 0;
      }
    }

    return values;
  }, [polygonAggregate, highlightedLineId, selectedDirection]);

  // ========= FEATURE TABLE LOGIC =========
  const polygonFeaturesSet = useMemo(() => new Set(polygonFeatures), [polygonFeatures]);

  const { showTable, tableRows, rowsReady } = useTableRowBuilder({
    isFeatureTableOpen,
    canton,
    featureGeoJSON,
    selectedGraph,
    setTableFilterQuery,
    useCache: false,
  });

  const activeTableRows = useMemo(() => {
    if (!polygonFeatures.length || !isFeatureTableOpen) return tableRows;
    return tableRows.filter(row => polygonFeaturesSet.has(row.feature));
  }, [tableRows, polygonFeaturesSet, polygonFeatures.length, isFeatureTableOpen]);

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        // sends to update attribute table on sidebar
        setSelectedTransitLink?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        // sends to zoom to feature on map
        setFeatureSelection?.(payload);
      }
    },
    [setFeatureSelection, setSelectedTransitLink]
  );

  const handleSelectCoords = useCallback(
    (coords, row) => {
      if (!row) return;
      handleTableRowSelect({ ...row, coords: coords || row.coords });
    },
    [handleTableRowSelect]
  );


  // Push to Map the selected transit stop mode filter
  const handleTransitModeChange = (event) => {
    const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
    if (selectedOptions.includes("all") || selectedOptions.length === 0) {
      setSelectedTransitModes(["all"]);
    } else {
      setSelectedTransitModes(selectedOptions);
    }
  };

  const handlePolygonLineClick = useCallback((lineId) => {
    setHighlightedLineId(highlightedLineId === lineId ? null : lineId);
  }, [highlightedLineId, setHighlightedLineId]);

  const [isPolygonSelectionCollapsed, setIsPolygonSelectionCollapsed] = useState(false);

  return (
    <div className="plot-container">
    {isFeatureTableOpen ? (
      <FeatureTable
      ref={transitFeatureTableRef}
      tableId="transit-volumes-feature-table"
      rows={activeTableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={selectedTransitModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
      showMajorRoadsOnly={false}
      selectedGraph={selectedGraph}
      />
    ) : (
      <>
    <div style={{ overflowY: "auto", overflowX: "hidden", width: "100%" }}>

    {/* Mode Filter Dropdown */}
    <div className="mode-filter-container">
    <label className="mode-filter-label">Filter by Mode:</label>
    <select
    multiple
    value={selectedTransitModes}
    onChange={handleTransitModeChange}
    className="mode-filter-select"
    >
    <option value="all">All</option>
    {availableTransitModes.map((mode) => (
      <option key={mode} value={mode}>
      {mode.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
      </option>
    ))}
    </select>
    </div>

    {/* Time Range + Checkbox Row — standalone row (not boxed inside the
        mode-filter card) so the sliders + checkbox sit in the same position as
        the road Volumes module's control row. */}
    <div className="right-sidebar-control-row">

    {/* Slider and label */}
    <div style={{ flex: 1 }}>
    <label className="right-sidebar-label" style={{ marginLeft: "7%" }}>
    Time: {formatTimeLabel(timeRange[0])} - {formatTimeLabel(timeRange[1])}
    </label>
    <Slider
    range
    min={0}
    max={96}
    step={1}
    marks={marks}
    value={timeRange}
    onChange={(val) => setTimeRange(val)}
    allowCross={false}
    style={{ marginLeft: "10%", width: "80%" }}
    />
    </div>

    {/* Label size slider (mirrors the road Volumes module) */}
    <div style={{ padding: "0 16px 12px 12px" }}>
    <label className="right-sidebar-label">
    Label size: {labelSize}px
    </label>
    <Slider
    min={8}
    max={24}
    step={1}
    value={labelSize}
    onChange={setLabelSize}
    style={{ width: "50%" }}
    />
    </div>

    {/* Checkbox */}
    <label className="right-sidebar-checkbox">
    <input
    type="checkbox"
    checked={showLineSymbology}
    onChange={(e) => setShowLineSymbology(e.target.checked)}
    />
    Toggle Stops
    </label>

    </div>

    {/* Polygon aggregate view */}
    {polygonAggregate && !selectedTransitLink && (
      <>
      <div className="canton-mode-share" style={{ position: "relative" }}>
        <span
          role="button"
          tabIndex={0}
          onClick={() => setIsPolygonSelectionCollapsed(v => !v)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsPolygonSelectionCollapsed(v => !v); }}
          aria-label={isPolygonSelectionCollapsed ? "Expand" : "Collapse"}
          style={{
            position: "absolute",
            top: 8,
            right: 16,
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
            userSelect: "none",
            color: "var(--color-text-secondary)",
          }}
        >
          {isPolygonSelectionCollapsed ? "+" : "−"}
        </span>
        <h4>Polygon Selection ({polygonAggregate.segmentCount} segments)</h4>
        {!isPolygonSelectionCollapsed && (
        <table>
          <tbody>
            <tr>
              <td>Modes</td>
              <td>{[...polygonAggregate.modesSet].join(', ')}</td>
            </tr>
            <tr>
              <td>Lines</td>
              <td>{Object.keys(polygonAggregate.mergedLines).length}</td>
            </tr>
            <tr>
              <td>Volumes</td>
              <td>
                <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
                  <div className="metric-card">
                    <div className="metric-label">Filtered Link Passes</div>
                    <div className="metric-value">{Math.round(polygonAggregate.filteredVolume).toLocaleString()}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">Total Link Passes</div>
                    <div className="metric-value">{Math.round(polygonAggregate.totalVolume).toLocaleString()}</div>
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <td><strong>Average Volume per Link</strong></td>
              <td>
                {polygonAggregate.segmentCount > 0
                  ? `${Math.round(polygonAggregate.totalVolume / polygonAggregate.segmentCount).toLocaleString()} passengers/day`
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Lines</td>
              <td>
                <div className="badge-container">
                  {Object.entries(polygonAggregate.mergedLines).map(([lineId, line]) => (
                    <span
                      key={lineId}
                      className={`mode-badge ${highlightedLineId === lineId ? "active" : ""}`}
                      onClick={() => handlePolygonLineClick(lineId)}
                    >
                      {line.line_name || lineId} ({line.mode})
                    </span>
                  ))}
                </div>
              </td>
            </tr>
            {highlightedLineId && (
            <tr>
              <td>Direction</td>
              <td>
                <DirectionToggle
                  value={selectedDirection}
                  onChange={setSelectedDirection}
                  labels={directionLabels}
                />
              </td>
            </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {boundaryAggregate && (
        <div className="canton-mode-share" style={{ marginBottom: 24 }}>
          <h4>Polygon Inflow/Outflow</h4>
          <table>
            <tbody>
              <tr>
                <td><strong>Crossing Segments</strong></td>
                <td>{boundaryAggregate.crossingCount}</td>
              </tr>
              <tr>
                <td><strong>Inflow</strong></td>
                <td>{Math.round(boundaryAggregate.inflow).toLocaleString()} passengers</td>
              </tr>
              <tr>
                <td><strong>Outflow</strong></td>
                <td>{Math.round(boundaryAggregate.outflow).toLocaleString()} passengers</td>
              </tr>
              <tr>
                <td><strong>Net Flow</strong></td>
                <td>
                  {boundaryAggregate.net >= 0 ? '+' : ''}
                  {Math.round(boundaryAggregate.net).toLocaleString()} passengers
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Aggregate histogram from polygon features */}
      {polygonHistogramData && (() => {
        const startTick = timeRange?.[0] ?? 0;
        const endTick = timeRange?.[1] ?? 96;
        const all15MinLabels = Array.from({ length: 96 }, (_, h) => {
          const hour = String(Math.floor(h / 4)).padStart(2, '0');
          const minute = String((h % 4) * 15).padStart(2, '0');
          return `${hour}:${minute}`;
        });
        const labels = all15MinLabels.slice(startTick, endTick);
        const values = polygonHistogramData.slice(startTick, endTick);
        const tickvals = labels.filter((_, i) => i % 4 === 0);

        return (
          <div className="plot-container">
            <h4>Aggregate Transit Volume ({polygonAggregate.segmentCount} segments)</h4>
            <Plot
              data={[{ x: labels, y: values, type: "bar", marker: { color: "#17becf" } }]}
              layout={{
                font: { family: "Inter, sans-serif" },
                margin: { t: 30, r: 10, l: 40, b: 100 },
                xaxis: { title: { text: "Time", standoff: 20 }, tickangle: -45, tickvals, automargin: true },
                yaxis: { title: "Passengers per 15 min" },
                height: 300, width: 525,
                paper_bgcolor: "rgba(255,255,255,0)", plot_bgcolor: "rgba(255,255,255,0)",
              }}
            />
          </div>
        );
      })()}
      </>
    )}

    {/* Per-link selector — only for a merged (low-zoom) selection bundling more
        than one link. Split (per-direction) selections isolate one direction
        already, so no dropdown there. */}
    {Array.isArray(selectedTransitLink) && selectedTransitLink.length > 0 && !polygonAggregate && !isSplit && allKeys.length > 1 && (
      <div className="link-selector" style={{ marginTop: 16 }}>
        <label>Link ID:</label>
        <select
          value={transitSelectedLink || ''}
          onChange={(e) => { setTransitSelectedLink(e.target.value || null); triggerVisualize(null); }}
        >
          <option value="">All ({allKeys.length} links)</option>
          {allKeys.map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      </div>
    )}

    {/* Link Attributes Table and Histograms — single selection */}
    {Array.isArray(selectedTransitLink) && selectedTransitLink.length > 0 && !polygonAggregate && (
      <>
      <TransitLinkAttributesTable
      propertiesList={selectedTransitLink}
      onLineClick={setHighlightedLineId}
      highlightedLineId={highlightedLineId}
      timeRange={timeRange}
      linkFilter={attrLinkFilter}
      volumesByLink={transitVolumesByLink}
      selectedDirection={selectedDirection}
      setSelectedDirection={setSelectedDirection}
      directionLabels={directionLabels}
      />

      <div style={{ height: 12 }} />

      {/* One histogram per effective link id (split direction / dropdown-narrowed
          / all links). */}
      {effectiveLinkIds.map(id => (
        <TransitLinkHistogram
        key={`transit-hist-${id}`}
        linkId={id}
        highlightedLineId={highlightedLineId}
        timeRange={timeRange}
        canton={canton}
        triggerVisualize={triggerVisualize}
        selectedDirection={selectedDirection}
        />
      ))}

      </>
    )}
    </div>
    </>
    )}
    </div>
  );
};

export default TransitVolumesModule;
