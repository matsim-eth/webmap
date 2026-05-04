import React, { useState, useCallback, useMemo } from "react";
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
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useModule } from "../../context/ModuleContext";
import { useMap } from "../../context/MapContext";

const VolumesModule = ({ featureTableRef }) => {
  const { isFeatureTableOpen, featureGeoJSON, setTableFilterQuery } = useData();
  const {
    selectedNetworkModes,
    showMajorRoadsOnly, setShowMajorRoadsOnly,
    timeRange, setTimeRange,
  } = useFilters();
  const {
    clickedCanton: canton,
    selectedNetworkFeature, setSelectedNetworkFeature,
    visualizeLinkId, setVisualizeLinkId,
    setFeatureSelection,
  } = useSelection();
  const { isGraphExpanded } = useModule();
  const { mapRef, drawRef, labelSize, setLabelSize } = useMap();

  const selectedGraph = isGraphExpanded;

  const [filteredVolume, setFilteredVolume] = useState(null);

  // Polygon selection
  const handlePolygonChange = useCallback(() => {
    setSelectedNetworkFeature?.(null);
  }, [setSelectedNetworkFeature]);

  const polygonFeatures = useLinePolygon({
    mapRef,
    drawRef,
    featureGeoJSON,
    isGraphExpanded,
    activeModule: 'Volumes',
    sourceId: 'network-source',
    layerIds: ['network-layer'],
    labelLayerIds: ['network-label-left', 'network-label-right'],
    showMajorRoadsOnly,
    onPolygonChange: handlePolygonChange,
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
    if (!polygonFeatures.length || !isFeatureTableOpen) return tableRows;
    return tableRows.filter(row => polygonFeaturesSet.has(row.feature));
  }, [tableRows, polygonFeaturesSet, polygonFeatures.length, isFeatureTableOpen]);

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
      selectedModes={selectedNetworkModes}
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
    onChange={(val) => setTimeRange(val)}
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

    {selectedNetworkFeature && !polygonAggregate && (
      <SegmentAttributesTable
      propertiesList={selectedNetworkFeature}
      selectedGraph={selectedGraph}
      filteredVolume={filteredVolume}
      />
    )}

    {selectedNetworkFeature && !polygonAggregate ? (
      <SegmentVolumeHistogram
      linkId={(() => {
        // Extract link IDs from pipe-separated per_id_keys
        const perIdKeys = selectedNetworkFeature[0]?.per_id_keys;
        if (perIdKeys && typeof perIdKeys === 'string') {
          const ids = perIdKeys.split("|").filter(Boolean);
          return ids.length ? ids : [String(selectedNetworkFeature[0]?.id ?? '')];
        }
        // Fallback to feature id if per_id_keys not available
        return [String(selectedNetworkFeature[0]?.id ?? '')];
      })()}
      visualizeLinkId={visualizeLinkId}
      setVisualizeLinkId={setVisualizeLinkId}
      canton={canton}
      timeRange={timeRange}
      onVolumeUpdate={setFilteredVolume}
      />
    ) : !polygonAggregate ? (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#9ca3af" }}>
      Click a canton and/or segment to see hourly volumes.
      </p>
    ) : null}
    </>
    )}
    </div>
  );
}

export default VolumesModule;
