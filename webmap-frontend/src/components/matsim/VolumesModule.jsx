import { useState, useCallback, useMemo } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import SegmentVolumeHistogram from "./SegmentVolumeHistogram";
import FeatureTable from "../table/FeatureTable";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import useLinePolygon from "../../hooks/useLinePolygon";
import useDrawPolygons from "../../hooks/useDrawPolygons";
import { computeBoundaryFlow } from "../../utils/boundaryFlow";
import { buildSelectionPayload } from "../table/_lib/rowSearch";
import { parsePipeList } from "../map/_lib/pipeProps";
import { isMajorRoad } from "../map/_lib/mapboxFilters";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useModule } from "../../context/ModuleContext";
import { useMap } from "../../context/MapContext";
import "./VolumeFlowModule.css";

// The Volumes map always renders car links only (useNetworkLayers applies a
// car filter on entry, with major-roads layered on top), so the feature table
// is car-only too. Module-level constant keeps a stable reference across
// renders (a fresh `['car']` each render would bust the table's row useMemo).
const VOLUMES_TABLE_MODES = ['car'];

const VolumesModule = ({ featureTableRef }) => {
  const { isFeatureTableOpen, featureGeoJSON, setTableFilterQuery, setPolygonLinkIds, zoneLabel } = useData();
  const {
    showMajorRoadsOnly, setShowMajorRoadsOnly,
    timeRange, setTimeRange,
  } = useFilters();
  const {
    clickedCanton: canton,
    selectedNetworkFeature, setSelectedNetworkFeature,
    triggerVisualize,
    setFeatureSelection,
    networkSelectedLink, setNetworkSelectedLink,
  } = useSelection();
  const { isGraphExpanded } = useModule();
  const { mapRef, drawRef, labelSize, setLabelSize, setMapLoading } = useMap();

  const selectedGraph = isGraphExpanded;

  const [filteredVolume, setFilteredVolume] = useState(null);

  // Per-link selection derived from the current selection (mirrors NetworkModule).
  //   isSplit        — per-direction (zoomed-in) selection; no dropdown.
  //   allKeys        — every link on the merged segment (drives the dropdown).
  //   effectiveLinks — links the histogram charts; >1 → summed (aggregate).
  //   attrLinkFilter — links the attribute table shows (null = all / "All").
  const selProps = selectedNetworkFeature?.[0];
  const isSplit = !!selProps?.ls_arrow;
  const allKeys = useMemo(() => parsePipeList(selProps?.per_id_keys), [selProps]);
  const effectiveLinks = useMemo(() => {
    if (isSplit) return parsePipeList(selProps?.ls_link_ids);
    if (networkSelectedLink) return [networkSelectedLink];
    return allKeys;
  }, [isSplit, selProps, networkSelectedLink, allKeys]);
  const attrLinkFilter = isSplit
    ? parsePipeList(selProps?.ls_link_ids)
    : (networkSelectedLink ? [networkSelectedLink] : null);

  // Polygon selection
  const handlePolygonChange = useCallback(() => {
    setSelectedNetworkFeature?.(null);
  }, [setSelectedNetworkFeature]);

  // No fade layerIds: outside-polygon links are hidden outright instead of
  // faded — the selected ids go to DataContext (polygonLinkIds), and
  // useFeatureSelectionFocus ANDs them into the combined Volumes map filter,
  // which covers the base layer AND the zoom>=15 split double-link layers
  // (their features carry `id = parent index`, the same id space).
  const polygonFeatures = useLinePolygon({
    mapRef,
    drawRef,
    featureGeoJSON,
    isGraphExpanded,
    activeModule: 'Volumes',
    sourceId: 'network-source',
    layerIds: [],
    labelLayerIds: [],
    showMajorRoadsOnly,
    onPolygonChange: handlePolygonChange,
    onSelectionIds: setPolygonLinkIds,
  });

  const drawnPolygons = useDrawPolygons({
    mapRef,
    drawRef,
    isGraphExpanded,
    activeModule: 'Volumes',
  });

  // Polygon aggregate
  const polygonAggregate = useMemo(() => {
    if (!polygonFeatures.length) return null;

    const allModes = new Set();
    let totalVolume = 0;
    const allLinkIds = [];

    for (const f of polygonFeatures) {
      const props = f.properties || {};
      const modes = (props.modes || '').split(',').filter(Boolean);
      modes.forEach(m => allModes.add(m));
      totalVolume += Number(props.daily_avg_volume) || 0;
      const keys = (props.per_id_keys || '').split('|').filter(Boolean);
      allLinkIds.push(...keys);
    }

    return {
      segmentCount: polygonFeatures.length,
      totalVolume,
      modes: [...allModes],
      allLinkIds,
    };
  }, [polygonFeatures]);

  // right_sum / left_sum on each feature are mutated time-filtered by
  // useNetworkLayers, so we depend on timeRange to recompute on slider change.
  const boundaryAggregate = useMemo(
    () => computeBoundaryFlow({ polygonFeatures, drawnPolygons }),
    [polygonFeatures, drawnPolygons, timeRange]
  );

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
    let rows = tableRows;
    // Mirror the map: with "major roads only" on, the map shows (and only fetches
    // volumes for) major-road segments, so the table lists just those too —
    // otherwise minor roads would appear with 0 volume from the major-only fetch.
    if (showMajorRoadsOnly) {
      rows = rows.filter(row => isMajorRoad(row.feature?.properties));
    }
    if (polygonFeatures.length && isFeatureTableOpen) {
      rows = rows.filter(row => polygonFeaturesSet.has(row.feature));
    }
    return rows;
  }, [tableRows, polygonFeaturesSet, polygonFeatures.length, isFeatureTableOpen, showMajorRoadsOnly]);

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        // sends to update attribute table on sidebar
        setSelectedNetworkFeature?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        // sends to zoom to feature on map
        setFeatureSelection?.(payload);
      }
    },
    [setFeatureSelection, setSelectedNetworkFeature]
  );

  const handleSelectCoords = useCallback(
    (coords, row) => {
      if (!row) return;
      handleTableRowSelect({ ...row, coords: coords || row.coords });
    },
    [handleTableRowSelect]
  );

  return (

    <div className="plot-container">
    {isFeatureTableOpen ? (
      <FeatureTable
      ref={featureTableRef}
      tableId="volumes-feature-table"
      rows={activeTableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={VOLUMES_TABLE_MODES}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
      showMajorRoadsOnly={showMajorRoadsOnly}
      selectedGraph={selectedGraph}
      />
    ) : (
      <>
    {/* Time Range Slider UI — shared with Transit */}
    <div className="right-sidebar-control-row">
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
    onChange={(val) => { setMapLoading?.(true); setTimeRange(val); }}
    allowCross={false}
    style={{ marginLeft: "10%", width: "80%" }}
    />
    </div>

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
    checked={showMajorRoadsOnly}
    onChange={(e) => setShowMajorRoadsOnly(e.target.checked)}
    />
    Show only major roads
    </label>
    </div>

    {/* Polygon aggregate view */}
    {polygonAggregate && !selectedNetworkFeature && (
      <>
      <div className="canton-mode-share">
        <h4>Polygon Selection</h4>
        <table>
          <tbody>
            <tr><td><strong>Selected Segments</strong></td><td>{polygonAggregate.segmentCount}</td></tr>
            <tr>
              <td><strong>Total Volume</strong></td>
              <td>{Math.round(polygonAggregate.totalVolume).toLocaleString()} Total Link Passes</td>
            </tr>
            <tr>
              <td><strong>Average Volume per Link</strong></td>
              <td>
                {polygonAggregate.segmentCount > 0
                  ? `${Math.round(polygonAggregate.totalVolume / polygonAggregate.segmentCount).toLocaleString()} vehicles/day`
                  : "-"}
              </td>
            </tr>
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
                <td>{Math.round(boundaryAggregate.inflow).toLocaleString()} vehicles</td>
              </tr>
              <tr>
                <td><strong>Outflow</strong></td>
                <td>{Math.round(boundaryAggregate.outflow).toLocaleString()} vehicles</td>
              </tr>
              <tr>
                <td><strong>Net Flow</strong></td>
                <td>
                  {boundaryAggregate.net >= 0 ? '+' : ''}
                  {Math.round(boundaryAggregate.net).toLocaleString()} vehicles
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <SegmentVolumeHistogram
        linkId={polygonAggregate.allLinkIds}
        canton={canton}
        timeRange={timeRange}
        aggregate
      />
      </>
    )}

    {/* Per-link selector — only for a merged (single-line, low-zoom) selection
        bundling more than one link. Split (per-direction) selections isolate one
        direction already, so no dropdown there. */}
    {selectedNetworkFeature && !polygonAggregate && !isSplit && allKeys.length > 1 && (
      <div className="link-selector">
        <label>Link ID:</label>
        <select
          value={networkSelectedLink || ''}
          onChange={(e) => { setNetworkSelectedLink(e.target.value || null); triggerVisualize(null); }}
        >
          <option value="">All ({allKeys.length} links)</option>
          {allKeys.map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      </div>
    )}

    {selectedNetworkFeature && !polygonAggregate && (
      <SegmentAttributesTable
      propertiesList={selectedNetworkFeature}
      selectedGraph={selectedGraph}
      filteredVolume={filteredVolume}
      linkFilter={attrLinkFilter}
      />
    )}

    {selectedNetworkFeature && !polygonAggregate ? (
      <SegmentVolumeHistogram
      linkId={effectiveLinks}
      aggregate={effectiveLinks.length > 1}
      triggerVisualize={triggerVisualize}
      canton={canton}
      timeRange={timeRange}
      onVolumeUpdate={setFilteredVolume}
      />
    ) : !polygonAggregate ? (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#9ca3af" }}>
      Click a {zoneLabel.toLowerCase()} and/or segment to see hourly volumes.
      </p>
    ) : null}
    </>
    )}
    </div>
  );
}

export default VolumesModule;
