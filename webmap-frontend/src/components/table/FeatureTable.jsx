// src/components/table/FeatureTable.jsx
import React, {
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";
import { useDebounced } from "../../hooks/useDebounced";

import $ from "jquery";
import dt from "datatables.net-dt";
import "datatables.net-dt/css/dataTables.dataTables.css";

import { buildRowsFromGeojson, modeMatches } from "./_lib/buildRows";
import { getColumnDefs, getDtColumns } from "./_lib/columns";
import { exportCsvFromInstance } from "./_lib/csv";
import { buildTableStyles } from "./_lib/tableStyles";
import {
  useDataTable,
  useDataTableSearch,
  useTableFilterQuerySync,
} from "../../hooks/useDataTable";

// Bind DT once
if (!$.fn.dataTable) {
  try {
    dt(window, $);
  } catch {
    try {
      dt($);
    } catch {}
  }
}

// Stable defaults — referenced by the destructuring defaults below so the
// reference is preserved across re-renders. Inlining these (e.g.
// `selectedModes = ["all"]`) creates a fresh array per render, busts
// downstream useMemo deps, and makes typing in the search box re-run the
// DataTables fast-path on every keystroke.
const DEFAULT_SELECTED_MODES = ["all"];
const DEFAULT_INITIAL_ORDER = [[0, "asc"]];

const FeatureTable = forwardRef(
  (
    {
      selectedGraph,
      geojson, // optional
      rows, // optional (wins over geojson)
      selectedModes = DEFAULT_SELECTED_MODES,
      onRowClick, // (row) => void
      onSelectCoords, // (coords, row) => void
      tableId = "feature-table",
      height = 360,
      useScroller = true,
      pageLength = 25,
      maxRows = 300000,
      loading = false,
      setTableFilterQuery,
      showMajorRoadsOnly = false,
      initialOrder = DEFAULT_INITIAL_ORDER,
      hideToolbar = false,
      hideFooter = false,
    },
    ref
  ) => {
    const tableRef = useRef(null);

    const tableStyles = useMemo(() => buildTableStyles(tableId), [tableId]);

    const baseRows = useMemo(() => {
      if (loading) return [];
      if (Array.isArray(rows) && rows.length) return rows;
      const built = buildRowsFromGeojson(geojson, selectedGraph);
      if (built.length) return built;
      return [];
    }, [loading, rows, geojson, selectedGraph]);

    const tableRows = useMemo(() => {
      let filtered = baseRows.filter((r) => modeMatches(r.modes, selectedModes));
      // Major-roads filter: match the map's predicate exactly. The map tests the
      // segment's representative `capacity` (['>', ['get','capacity'], 1200]),
      // NOT the summed-across-directions totalCapacity — the sum let sub-1200
      // segments (e.g. 700+700) through that the map hides, so the table showed
      // links the map had filtered out.
      if (showMajorRoadsOnly) {
        filtered = filtered.filter((r) => {
          const cap = Number(r.featureProps?.capacity ?? r.capacity);
          return Number.isFinite(cap) && cap > 1200;
        });
      }
      return filtered.slice(0, maxRows);
    }, [baseRows, selectedModes, maxRows, showMajorRoadsOnly]);

    const hasNoData = tableRows.length === 0;

    // Single source of truth for columns
    const columnDefs = useMemo(() => getColumnDefs(selectedGraph), [selectedGraph]);
    const dtColumns  = useMemo(() => getDtColumns(selectedGraph),  [selectedGraph]);

    // Toolbar state
    const [searchCol, setSearchCol] = useState(-1);
    const [searchText, setSearchText] = useState("");
    const debouncedSearch = useDebounced(searchText, 350);

    // DataTables instance lifecycle
    const dtRef = useDataTable({
      tableRef,
      rows: tableRows,
      baseRowsCount: baseRows.length,
      columns: dtColumns,
      useScroller,
      height,
      pageLength,
      initialOrder,
      loading,
      hasNoData,
      onRowClick,
      onSelectCoords,
      hideFooter,
    });

    // Search → DataTables filter (numeric ops, accent expansion, etc.)
    useDataTableSearch({
      dtRef,
      searchCol,
      debouncedSearch,
      searchText,
      dtColumns,
      selectedGraph,
      tableRows,
    });

    // Search → tableFilterQuery context (drives the map-side filter). Runs
    // after useDataTableSearch so the DT instance already reflects the applied
    // search; emits the matched-row id set the map mirrors directly.
    useTableFilterQuerySync({
      dtRef,
      searchCol,
      debouncedSearch,
      searchText,
      dtColumns,
      tableRows,
      setTableFilterQuery,
    });

    // Native CSV exporter (no DT Buttons dependency)
    useImperativeHandle(ref, () => ({
      exportCsv: () =>
        exportCsvFromInstance(dtRef.current, columnDefs, `${tableId}_export.csv`),
    }));

    // UI states
    if (loading) {
      return (
        <div
          className="feature-table-state"
          style={{ height }}
        >
          <span>Preparing table…</span>
        </div>
      );
    }

    if (hasNoData) {
      return (
        <div
          className="feature-table-state feature-table-state--empty"
          style={{ height }}
        >
          <span>No segment data available</span>
        </div>
      );
    }

    return (
      <div className="w-full" style={{ minHeight: 200 }}>
        {!hideToolbar && (
        <div id={`${tableId}-toolbar`}>
          <label>Search in:</label>
          <select
            value={String(searchCol)}
            onChange={(e) => setSearchCol(parseInt(e.target.value, 10))}
          >
            <option value="-1">All columns</option>
            {dtColumns
              .filter((c) => c.title && c.visible !== false)
              .map((c) => {
                const originalIdx = dtColumns.indexOf(c);
                return (
                  <option key={originalIdx} value={originalIdx}>
                    {c.title}
                  </option>
                );
              })}
          </select>
          <input
            type="text"
            placeholder="Type to search… (; for multiple)"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              setSearchText("");
              setSearchCol(-1);
            }}
            title="Clear search"
          >
            Clear
          </button>
          <span className="search-guide-wrapper">
            <span className="search-guide-icon">i</span>
            <div className="search-guide-tooltip">
              <strong>Search Guide</strong>
              <hr />
              <p><b>Basic search:</b> type any text to filter rows</p>
              <p>
                <b>Multiple terms:</b> separate with <code>;</code> or <code>,</code> to match any
                <br />
                <em>e.g.</em> <code>bus;tram</code>
              </p>
              <p><b>Numeric comparisons</b> (numeric columns only):</p>
              <ul>
                <li><code>&gt;100</code> - greater than</li>
                <li><code>&lt;100</code> - less than</li>
                <li><code>&gt;=100</code> - greater than or equal</li>
                <li><code>&lt;=100</code> - less than or equal</li>
              </ul>
              <p><b>All columns:</b> partial match across every column</p>
              <p>
                <b>Specific column:</b> exact match (except Modes
                {selectedGraph === 'Transit' ? <> &amp; Stop Name</> : null} which use partial match)
              </p>
              {selectedGraph === 'Transit' && (
                <p><b>Accent insensitive:</b> <code>geneve</code> matches <code>Genève</code></p>
              )}
            </div>
          </span>
        </div>
        )}

        <table
          id={tableId}
          ref={tableRef}
          className="display stripe hover compact"
          style={{ width: "100%" }}
        />
        <style>{tableStyles}</style>
      </div>
    );
  }
);

export default FeatureTable;
