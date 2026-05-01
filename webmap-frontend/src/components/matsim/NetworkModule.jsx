import React, { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable from "../table/FeatureTable";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import { buildSelectionPayload } from "../table/_lib/rowSearch";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useModule } from "../../context/ModuleContext";
import { useFileContext } from "../../FileContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

// Modes excluded from the canton mode-filter dropdown — these are aggregate
// or non-road modes the user can't usefully filter on at the network level.
const EXCLUDED_MODES = ["car_passenger", "truck", "rail", "other", "pt", "taxi"];

const NetworkModule = ({ featureTableRef }) => {
  const { dataURL, isFeatureTableOpen, featureGeoJSON, setTableFilterQuery } = useData();
  const { selectedNetworkModes, setSelectedNetworkModes } = useFilters();
  const { clickedCanton: canton, selectedNetworkFeature, setSelectedNetworkFeature, setFeatureSelection } = useSelection();
  const { isGraphExpanded: selectedGraph } = useModule();
  const { fileMap } = useFileContext();
  const loadWithFallback = useLoadWithFallback(dataURL);

  // Per-canton mode list — drives the multi-select dropdown.
  const { data: modesByCanton = {} } = useQuery({
    queryKey: ['modes-by-canton', dataURL, fileMap.size],
    queryFn: () => loadWithFallback("modes_by_canton.json"),
  });

  const availableModes = useMemo(() => {
    if (canton && modesByCanton[canton]) {
      return modesByCanton[canton].filter((mode) => !EXCLUDED_MODES.includes(mode));
    }
    return [];
  }, [canton, modesByCanton]);

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
