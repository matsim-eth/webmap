import React, { useCallback, useMemo } from "react";
import Plot from "react-plotly.js";
import TransitLinkAttributesTable from "./TransitLinkAttributesTable";
import TransitLinkHistogram from "./TransitLinkHistogram";
import FeatureTable from "../table/FeatureTable";
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import useLinePolygon from "../../hooks/useLinePolygon";
import useDrawPolygons from "../../hooks/useDrawPolygons";
import { useTransitVolumeHighlightSync } from "../../hooks/useTransitVolumeHighlightSync";
import { computeBoundaryFlow } from "../../utils/boundaryFlow";

// get coords and id of selected row
const buildSelectionPayload = (row) => {
  if (!row) return null;
  const coords = row.coords;
  const id = row.rowKey;
  const feature = row.feature;
  return { id, feature, coords };
};

const TransitVolumesModule = ({
  selectedTransitLink, // clicked transit segment(s)
  setSelectedTransitLink,
  timeRange,
  setTimeRange,
  availableTransitModes,
  selectedTransitModes,
  setSelectedTransitModes,
  canton,
  showLineSymbology,
  setShowLineSymbology,
  setHighlightedLineId,
  highlightedLineId,
  visualizeLinkId,
  setVisualizeLinkId,
  isFeatureTableOpen,
  featureGeoJSON,
  transitFeatureTableRef,
  setTableFilterQuery,
  selectedGraph,
  onFocusTransitFeature,
  drawRef,
  mapRef,
  isGraphExpanded
}) => {

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
    layerIds: ['transit-volumes-layer'],
    labelLayerIds: ['transit-volumes-label-left', 'transit-volumes-label-right'],
    onPolygonChange: handlePolygonChange,
    fadeOpacity: 0.05,
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

  // Polygon aggregate histogram data — sum all lines' timeBins into 96 bins
  const polygonHistogramData = useMemo(() => {
    if (!polygonAggregate) return null;

    const values = new Array(96).fill(0);
    const lines = polygonAggregate.mergedLines;
    const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

    for (const id of lineIds) {
      const bins = lines[id]?.timeBins || {};
      for (let h = 0; h < 96; h++) {
        const hour = String(Math.floor(h / 4)).padStart(2, '0');
        const minute = String((h % 4) * 15).padStart(2, '0');
        values[h] += Number(bins[`${hour}:${minute}`]) || 0;
      }
    }

    return values;
  }, [polygonAggregate, highlightedLineId]);

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
        onFocusTransitFeature?.(payload);
      }
    },
    [onFocusTransitFeature, setSelectedTransitLink]
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
    {/* Time Range + Checkbox Row */}
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

    </div>

    {/* Polygon aggregate view */}
    {polygonAggregate && !selectedTransitLink && (
      <>
      <div className="canton-mode-share">
        <h4>Polygon Selection ({polygonAggregate.segmentCount} segments)</h4>
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
                    <div className="metric-label">Filtered</div>
                    <div className="metric-value">{Math.round(polygonAggregate.filteredVolume)}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">Total</div>
                    <div className="metric-value">{Math.round(polygonAggregate.totalVolume)}</div>
                  </div>
                </div>
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
          </tbody>
        </table>
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

    {/* Link Attributes Table and Histograms — single selection */}
    {Array.isArray(selectedTransitLink) && selectedTransitLink.length > 0 && !polygonAggregate && (
      <>
      <TransitLinkAttributesTable
      propertiesList={selectedTransitLink}
      onLineClick={setHighlightedLineId}
      highlightedLineId={highlightedLineId}
      timeRange={timeRange}
      />

      <div style={{ height: 12 }} />

      {(() => {
        // Collect all unique link IDs across all selected segments
        const allLinkIds = new Set();
        selectedTransitLink.forEach(props => {
          const ids = Array.isArray(props.link_ids) && props.link_ids.length
            ? props.link_ids
            : (props.per_id_keys ? props.per_id_keys.split("|").filter(Boolean) : []);
          ids.forEach(id => allLinkIds.add(String(id)));
        });

        // Create one histogram per unique link ID
        return Array.from(allLinkIds).map(id => (
          <TransitLinkHistogram
          key={`transit-hist-${id}`}
          linkId={id}
          highlightedLineId={highlightedLineId}
          timeRange={timeRange}
          canton={canton}
          visualizeLinkId={visualizeLinkId}
          setVisualizeLinkId={setVisualizeLinkId}
          />
        ));
      })()}

      </>
    )}
    </div>
    </>
    )}
    </div>
  );
};

export default TransitVolumesModule;
