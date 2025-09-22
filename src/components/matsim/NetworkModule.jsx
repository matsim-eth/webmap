import React, { useCallback, useEffect, useState } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable from "../table/FeatureTable";

const deriveCoords = (row) => {
  if (!row) return null;
  const coords = row.coords;
  if (Array.isArray(coords) && coords.length) {
    return coords;
  }
  const geometry = row.feature?.geometry;
  if (!geometry) return null;
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flat();
  }
  return null;
};

const buildSelectionPayload = (row) => {
  if (!row) return null;
  const feature = row.feature;
  const coords = deriveCoords(row);
  if (!feature || !coords || !coords.length) {
    return null;
  }
  const props = row.featureProps || feature.properties || {};
  const id =
    props.id ||
    props.link_id ||
    props.segment_id ||
    props.objectid ||
    feature.id ||
    row.segmentLabel ||
    row.rowKey ||
    null;
  return { id, feature, coords };
};

const NetworkModule = ({
  canton,
  selectedNetworkModes,
  availableModes,
  selectedNetworkFeature,
  setSelectedNetworkFeature,
  handleModeChange,
  isFeatureTableOpen,
  featureGeoJSON,
  onFocusNetworkFeature,
}) => {
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    if (isFeatureTableOpen) {
      const timer = setTimeout(() => setShowTable(true), 350);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    return undefined;
  }, [isFeatureTableOpen]);

  useEffect(() => () => onFocusNetworkFeature?.(null), [onFocusNetworkFeature]);

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        setSelectedNetworkFeature?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        onFocusNetworkFeature?.(payload);
      }
    },
    [onFocusNetworkFeature, setSelectedNetworkFeature]
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
          tableId="network-feature-table"
          geojson={featureGeoJSON}
          selectedModes={selectedNetworkModes}
          onRowClick={handleTableRowSelect}
          onSelectCoords={handleSelectCoords}
          height={360}
          useScroller
          loading={!showTable}
        />
      ) : (
        <>
          {canton ? (
            <div className="mode-filter-container">
              <label className="mode-filter-label">Filter by Mode:</label>
              <select
                multiple
                value={selectedNetworkModes}
                onChange={handleModeChange}
                className="mode-filter-select"
              >
                <option value="all">All</option>
                {availableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
              Click a canton to view MATSim network links.
            </p>
          )}

          {selectedNetworkFeature && (
            <SegmentAttributesTable propertiesList={selectedNetworkFeature} />
          )}
        </>
      )}
    </div>
  );
};

export default NetworkModule;
