import React, { useCallback, useMemo } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable from "../table/FeatureTable";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";
import { buildSelectionPayload } from "../table/_lib/rowSearch";
import { parsePipeList } from "../map/_lib/pipeProps";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useModule } from "../../context/ModuleContext";
import "./VolumeFlowModule.css";

// Modes hidden from the network filter: car_passenger/train/taxi/truck ride
// along the same links as their primary mode (car/rail), so filtering on them
// isn't useful at the network level.
const EXCLUDED_MODES = new Set([
  "car_passenger", "train", "taxi", "truck",
]);

const NetworkModule = ({ featureTableRef }) => {
  const { isFeatureTableOpen, featureGeoJSON, setTableFilterQuery, zoneLabel } = useData();
  const { selectedNetworkModes, setSelectedNetworkModes } = useFilters();
  const {
    clickedCanton: canton,
    selectedNetworkFeature, setSelectedNetworkFeature, setFeatureSelection,
    networkSelectedLink, setNetworkSelectedLink,
  } = useSelection();
  const { isGraphExpanded: selectedGraph } = useModule();

  // Per-link selection state derived from the current selection.
  //   isSplit       — a per-direction (zoomed-in) selection; no dropdown, the
  //                   attribute table shows just that direction's link(s).
  //   allKeys       — every link on the merged segment (drives the dropdown).
  //   linkFilter    — which links the attribute table shows: the split direction,
  //                   the dropdown pick, or null (= all links / "All").
  const selProps = selectedNetworkFeature?.[0];
  const isSplit = !!selProps?.ls_arrow;
  const allKeys = useMemo(() => parsePipeList(selProps?.per_id_keys), [selProps]);
  const linkFilter = isSplit
    ? parsePipeList(selProps?.ls_link_ids)
    : (networkSelectedLink ? [networkSelectedLink] : null);

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
        Click a {zoneLabel.toLowerCase()} to view MATSim network links.
        </p>
      )}

      {/* Per-link selector — only for a merged (single-line, low-zoom) selection
          bundling more than one link. Split (zoomed-in, per-direction) selections
          already isolate one direction, so no dropdown there. */}
      {selectedNetworkFeature && !isSplit && allKeys.length > 1 && (
        <div className="link-selector">
          <label>Link ID:</label>
          <select
            value={networkSelectedLink || ''}
            onChange={(e) => setNetworkSelectedLink(e.target.value || null)}
          >
            <option value="">All ({allKeys.length} links)</option>
            {allKeys.map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        </div>
      )}

      {selectedNetworkFeature && (
        <SegmentAttributesTable propertiesList={selectedNetworkFeature} linkFilter={linkFilter} />
      )}
      </>
    )}
    </div>
  );
};

export default NetworkModule;
