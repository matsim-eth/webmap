// src/components/table/FeatureTable.jsx
import React, { useEffect, useMemo, useRef } from "react";

import $ from "jquery";
import dt from "datatables.net-dt";
import "datatables.net-dt/css/dataTables.dataTables.css"; // base DT CSS only

// Bind DT to this jQuery instance (idempotent)
if (!$.fn.dataTable) {
  try { dt(window, $); } catch { try { dt($); } catch {} }
}

/* ---------------- helpers ---------------- */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const toKmh = (mps) => {
  const n = Number(mps);
  return Number.isFinite(n) ? n * 3.6 : null;
};
const fmt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
    : "-";
};
const modeMatches = (rowModes, selectedModes) => {
  if (!Array.isArray(selectedModes) || selectedModes.length === 0 || selectedModes.includes("all")) return true;
  const modes = String(rowModes || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!modes.length) return false;
  return selectedModes.some((m) => modes.includes(m));
};

const buildRowsFromGeojson = (geojson) => {
  if (!geojson?.features) return [];
  const rows = [];
  geojson.features.forEach((feature, featureIndex) => {
    const props = feature?.properties || {};
    let per = props.per_id;
    if (typeof per === "string") { try { per = JSON.parse(per); } catch { per = {}; } }
    if (!per || typeof per !== "object" || Array.isArray(per)) per = {};

    const tableId = Number(props.__tableId ?? featureIndex);
    const segmentLabel =
      props.id ?? props.link_id ?? props.segment_id ?? props.objectid ?? props.osm_id ?? `Segment ${featureIndex + 1}`;

    // coords for map zoom
    const g = feature?.geometry || {};
    const coords =
      g.type === "LineString" ? g.coordinates :
      g.type === "MultiLineString" ? g.coordinates.flat() :
      null;

    const pushRow = (directionId, data = {}) => {
      rows.push({
        rowKey: `${tableId}-${directionId ?? "all"}-${rows.length}`,
        tableId,
        segmentLabel,
        directionId: directionId ?? null,
        length: num(data.length ?? props.length),
        freeSpeed: toKmh(data.freespeed ?? props.freespeed),
        capacity: num(data.capacity ?? props.capacity),
        dailyAvg: num(data.daily_avg_volume ?? props.daily_avg_volume),
        modes: props.modes || "",
        coords,
        feature,
        featureProps: props,
      });
    };

    const entries = Object.entries(per);
    if (entries.length) entries.forEach(([dir, d]) => pushRow(dir, d || {}));
    else pushRow(null, {});
  });
  return rows;
};

/* ---------------- component ---------------- */
const FeatureTable = ({
  geojson,                 // optional
  rows,                    // optional (wins over geojson)
  selectedModes = ["all"],
  onRowClick,              // (row) => void
  onSelectCoords,          // (coords, row) => void
  tableId = "feature-table",
  height = 360,            // used for Scroller
  useScroller = true,      // true: virtual scroll; false: regular paging
  showButtons = true,      // show Copy/CSV buttons
  pageLength = 25,
  maxRows = 4000, //for testing //75000,
  loading = false,        
}) => {
  const tableRef = useRef(null);
  const dtRef = useRef(null);

  const baseRows = useMemo(() => {
    if (Array.isArray(rows) && rows.length) return rows;
    const built = buildRowsFromGeojson(geojson);
    if (built.length) return built;
    return [];
  }, [rows, geojson]);

  const tableRows = useMemo(() => {
    const filtered = baseRows.filter((r) => modeMatches(r.modes, selectedModes));
    return filtered.slice(0, maxRows);
  }, [baseRows, selectedModes, maxRows]);

  const hasNoData = tableRows.length === 0;

  useEffect(() => {
    let cancelled = false;

    // If loading or no data, ensure any DT instance is torn down and skip init.
    if (loading || hasNoData) {
      const el = tableRef.current;
      try { dtRef.current?.destroy(true); } catch {}
      dtRef.current = null;
      if (el?._dt) { try { el._dt.destroy(true); } catch {} el._dt = null; }
      if (el) el.innerHTML = "";
      return;
    }

    const init = async () => {
      const el = tableRef.current;
      if (!el) return;

      // Destroy prior instance (avoid reinit errors)
      if (dtRef.current) { try { dtRef.current.destroy(true); } catch {} dtRef.current = null; }
      if (el._dt)        { try { el._dt.destroy(true); }        catch {} el._dt = null; }

      // Build static header/structure
      el.innerHTML = `
        <thead>
          <tr>
            <th>Segment IDs</th>
            <th>Direction</th>
            <th>Length (m)</th>
            <th>Free Speed (km/h)</th>
            <th>Capacity</th>
            <th>Avg Daily Volume</th>
            <th>Modes</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;

      // Dynamically import plugins AFTER DataTables is bound to $
      if (showButtons) {
        await import("datatables.net-buttons");
        await import("datatables.net-buttons/js/buttons.html5");
        await import("datatables.net-buttons-dt/css/buttons.dataTables.css");
      }
      if (useScroller) {
        await import("datatables.net-scroller");
        await import("datatables.net-scroller-dt/css/scroller.dataTables.css");
      }
      if (cancelled) return;

      const columns = [
        { data: "segmentLabel" },
        { data: "directionId" },
        { data: "length",    render: (v) => fmt(v, 1) },
        { data: "freeSpeed", render: (v) => fmt(v, 1) },
        { data: "capacity",  render: (v) => fmt(v) },
        { data: "dailyAvg",  render: (v) => fmt(v) },
        { data: "modes",     render: (v) => (v ? String(v).replace(/,/g, ", ") : "-") },
      ];

      const instance = $(el).DataTable({
        data: tableRows,
        columns,
        autoWidth: false,
        order: [[0, "asc"]],
        dom: showButtons ? (useScroller ? "Bfrti" : "Bfrtip") : (useScroller ? "frti" : "frtip"),
        buttons: showButtons
          ? [
              { extend: "copyHtml5", title: "network_segments" },
              { extend: "csvHtml5", title: "network_segments" },
            ]
          : [],
        ...(useScroller
          ? { scrollY: height, scroller: true, paging: true }
          : { paging: true, pageLength }),
        rowId: (row) => row.rowKey || `row-${row.tableId}-${row.directionId ?? "all"}`,
        language: {
          emptyTable: baseRows.length
            ? "No rows match the current filters"
            : "No segment data available",
        },
      });

      const onClick = (e) => {
        const tr = e.target.closest("tr");
        if (!tr || !tr.closest("tbody")) return;
        const rowData = instance.row(tr).data();
        if (!rowData) return;

        // selection styling
        [...tr.parentElement.children].forEach((r) => r.classList.remove("row-selected"));
        tr.classList.add("row-selected");

        onRowClick?.(rowData);
        onSelectCoords?.(rowData.coords ?? null, rowData);
      };
      el.addEventListener("click", onClick);

      dtRef.current = instance;
      el._dt = instance;

      return () => el.removeEventListener("click", onClick);
    };

    init();

    return () => {
      cancelled = true;
      const el = tableRef.current;
      try { dtRef.current?.destroy(true); } catch {}
      dtRef.current = null;
      if (el?._dt) { try { el._dt.destroy(true); } catch {} el._dt = null; }
    };
  }, [
    loading,
    hasNoData,
    tableRows,
    baseRows.length,
    selectedModes,
    useScroller,
    height,
    pageLength,
    showButtons,
    onRowClick,
    onSelectCoords,
  ]);

  // UI states managed here
  if (loading) {
    return (
      <div
        className="w-full"
        style={{ height, display: "grid", placeItems: "center", opacity: 0.85 }}
      >
        <span>Preparing table…</span>
      </div>
    );
  }

  if (hasNoData) {
    return (
      <div
        className="w-full"
        style={{ height, display: "grid", placeItems: "center", color: "#888", fontStyle: "italic" }}
      >
        <span>No segment data available</span>
      </div>
    );
  }

  // Normal DT rendering
  return (
    <div className="w-full" style={{ minHeight: 200 }}>
      <table
        id={tableId}
        ref={tableRef}
        className="display stripe hover compact"
        style={{ width: "100%" }}
      />
      <style>{`.row-selected{background-color:rgba(0,123,255,.12)!important;}`}</style>
    </div>
  );
};

export default FeatureTable;
