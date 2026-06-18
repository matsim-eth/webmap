import React, { useCallback, useMemo } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable from "../table/FeatureTable";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import { buildSelectionPayload } from "../table/_lib/rowSearch";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useModule } from "../../context/ModuleContext";

// Modes hidden from the network filter: car_passenger/train/taxi/truck ride
// along the same links as their primary mode (car/rail), so filtering on them
// isn't useful at the network level.
const EXCLUDED_MODES = new Set([
  "car_passenger", "train", "taxi", "truck",
]);

const NetworkModule = ({ featureTableRef }) => {
  const { isFeatureTableOpen, featureGeoJSON, setTableFilterQuery } = useData();
  const { selectedNetworkModes, setSelectedNetworkModes } = useFilters();
  const { clickedCanton: canton, selectedNetworkFeature, setSelectedNetworkFeature, setFeatureSelection } = useSelection();
  const { isGraphExpanded: selectedGraph } = useModule();

  // Available modes = the distinct transport modes actually present on the
  // canton's network links. The enriched merged_segments geometry carries the
  // real per-link `modes` (comma-joined, e.g. "car,car_passenger,taxi,truck"),
  // so we union them across the loaded features — far more accurate than the
  // old trip-based modes_by_canton list (which only knew car/pt/walk/bike/
  // car_passenger, then got further trimmed to car/walk/bike).
  const availableModes = useMemo(() => {
    const feats = featureGeoJSON?.features;
    if (!feats || feats.length === 0) return [];
    const set = new Set();
    for (const f of feats) {
      const m = f?.properties?.modes;
      if (!m) continue;
      for (const part of String(m).split(",")) {
        const t = part.trim();
        if (t && !EXCLUDED_MODES.has(t)) set.add(t);
      }
    }
    return Array.from(set).sort();
  }, [featureGeoJSON]);

  const handleModeChange = (event) => {
    const selectedOptions = Array.from(event.target.selectedOptions).map((o) => o.value);
    if (selectedOptions.includes("all") || selectedOptions.length === 0) {
      setSelectedNetworkModes(["all"]);
    } else {
      setSelectedNetworkModes(selectedOptions);
    }
  };

  const { showTable, tableRows, rowsReady } = useTableRowBuilder({
    isFeatureTableOpen,
    canton,
    featureGeoJSON,
    selectedGraph,
    setTableFilterQuery,
    useCache: true,
  });

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        setSelectedNetworkFeature?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
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
      selectedGraph={selectedGraph}
      tableId="network-feature-table"
      rows={tableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={selectedNetworkModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
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
