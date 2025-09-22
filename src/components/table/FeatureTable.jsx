// src/components/table/FeatureTable.jsx
import React, { useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from "react";

import $ from "jquery";
import dt from "datatables.net-dt";
import "datatables.net-dt/css/dataTables.dataTables.css";

// Bind DT once
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

/** Faster: precompute formatted strings once per row; keep raw numbers for sort */
export const buildRowsFromGeojson = (geojson) => {
  if (!geojson?.features) return [];
  const rows = [];
  geojson.features.forEach((feature, featureIndex) => {
    const props = feature?.properties || {};
    let per = props.per_id;
    if (typeof per === "string" && per.startsWith("{")) { // avoid try/catch unless looks like JSON
      try { per = JSON.parse(per); } catch { per = {}; }
    }
    if (!per || typeof per !== "object" || Array.isArray(per)) per = {};

    const tableId = Number(props.__tableId ?? featureIndex);
    const segmentLabel =
      props.id ?? props.link_id ?? props.segment_id ?? props.objectid ?? props.osm_id ?? `Segment ${featureIndex + 1}`;

    // coords for map zoom (kept for compatibility; if large, consider switching to bbox)
    const g = feature?.geometry || {};
    const coords =
      g.type === "LineString" ? g.coordinates :
      g.type === "MultiLineString" ? g.coordinates.flat() :
      null;

    const pushRow = (directionId, data = {}) => {
      const length = num(data.length ?? props.length);
      const freeSpeed = toKmh(data.freespeed ?? props.freespeed);
      const capacity = num(data.capacity ?? props.capacity);
      const dailyAvg = num(data.daily_avg_volume ?? props.daily_avg_volume);

      rows.push({
        rowKey: `${tableId}-${directionId ?? "all"}-${rows.length}`,
        tableId,
        segmentLabel,
        directionId: directionId ?? null,

        // raw numbers (used for sorting)
        length,
        freeSpeed,
        capacity,
        dailyAvg,

        // preformatted display strings (so column render isn't called per cell)
        length_fmt: fmt(length, 1),
        freeSpeed_fmt: fmt(freeSpeed, 1),
        capacity_fmt: fmt(capacity),
        dailyAvg_fmt: fmt(dailyAvg),

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
const FeatureTable = forwardRef(({
  geojson,                 // optional
  rows,                    // optional (wins over geojson)
  selectedModes = ["all"],
  onRowClick,              // (row) => void
  onSelectCoords,          // (coords, row) => void
  tableId = "feature-table",
  height = 360,            // used for Scroller
  useScroller = true,      // true: virtual scroll; false: regular paging
  pageLength = 25,
  maxRows = 75000,          // for testing
  loading = false,
}, ref) => {
  const tableRef = useRef(null);
  const dtRef = useRef(null);
  const pluginsLoadedRef = useRef({ buttons: false, scroller: false });

  useImperativeHandle(ref, () => ({
    exportCsv: () => {
      const instance = dtRef.current;
      if (!instance?.button) return false;
      try {
        instance.button('.buttons-csv').trigger();
        return true;
      } catch (err) {
        console.warn('FeatureTable exportCsv failed', err);
        return false;
      }
    },
  }));

  const tableStyles = useMemo(() => `
.row-selected{background-color:rgba(0,123,255,.12)!important;}
#${tableId}_wrapper .dt-buttons{display:none!important;}
`, [tableId]);

  const baseRows = useMemo(() => {
    if (loading) return [];
    if (Array.isArray(rows) && rows.length) return rows;
    const built = buildRowsFromGeojson(geojson);
    if (built.length) return built;
    return [];
  }, [loading, rows, geojson]);

  const tableRows = useMemo(() => {
    const filtered = baseRows.filter((r) => modeMatches(r.modes, selectedModes));
    return filtered.slice(0, maxRows);
  }, [baseRows, selectedModes, maxRows]);

  const hasNoData = tableRows.length === 0;

  useEffect(() => {
    let cancelled = false;
    const el = tableRef.current;

    const destroyIfAny = () => {
      try { dtRef.current?.destroy(true); } catch {}
      dtRef.current = null;
      if (el?._dt) { try { el._dt.destroy(true); } catch {} el._dt = null; }
    };

    // If loading or no data, tear down and skip
    if (loading || hasNoData) {
      destroyIfAny();
      if (el) el.innerHTML = "";
      return;
    }

    const init = async () => {
      if (!el) return;

      // Load plugins once (cache in ref)
      if (!pluginsLoadedRef.current.buttons) {
        await import("datatables.net-buttons");
        await import("datatables.net-buttons/js/buttons.html5");
        await import("datatables.net-buttons-dt/css/buttons.dataTables.css");
        pluginsLoadedRef.current.buttons = true;
      }
      if (useScroller && !pluginsLoadedRef.current.scroller) {
        await import("datatables.net-scroller");
        await import("datatables.net-scroller-dt/css/scroller.dataTables.css");
        pluginsLoadedRef.current.scroller = true;
      }
      if (cancelled) return;

      // Columns: display preformatted strings, sort by raw numbers (no render fn per cell)
      const columns = [
        { data: "segmentLabel", title: "Segment IDs" },
        { data: "directionId",  title: "Direction" },
        { data: { _: "length_fmt",    sort: "length"    }, title: "Length [m]" },
        { data: { _: "freeSpeed_fmt", sort: "freeSpeed" }, title: "Free Speed [km/h]" },
        { data: { _: "capacity_fmt",  sort: "capacity"  }, title: "Capacity" },
        { data: { _: "dailyAvg_fmt",  sort: "dailyAvg"  }, title: "Avg Daily Volume" },
        {
          data: "modes",
          title: "Modes",
          render: (v) => (v ? String(v).replace(/,/g, ", ") : "-"),
        },
      ];

      // Fast path: if already initialized, update rows only
      if (dtRef.current && el._dt) {
        const instance = dtRef.current;
        instance.clear();
        instance.rows.add(tableRows);
        instance.draw(false);
        return;
      }

      // Fresh init: build header once
      el.innerHTML = `
        <thead>
          <tr>${columns.map((c) => `<th>${c.title}</th>`).join("")}</tr>
        </thead>
        <tbody></tbody>
      `;

      const instance = $(el).DataTable({
        data: tableRows,
        columns,
        autoWidth: false,
        order: [[0, "asc"]],
        dom: useScroller ? "Bfrti" : "Bfrtip",
        buttons: [
          { extend: "csvHtml5", title: "network_segments" },
        ],
        ...(useScroller
          ? { scrollY: height, scroller: true, paging: true, deferRender: true }
          : { paging: true, pageLength }),
        rowId: (row) => row.rowKey || `row-${row.tableId}-${row.directionId ?? "all"}`,
        language: {
          emptyTable: baseRows.length
            ? "No rows match the current filters"
            : "No segment data available",
        },
        processing: true,
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

      return () => {
        el.removeEventListener("click", onClick);
      };
    };

    init();

    return () => {
      cancelled = true;
      // Don't destroy here by default — keep instance for fast updates.
      // It will be destroyed above when loading/hasNoData, or when component unmounts:
      // (uncomment next lines if you want hard-destroy on unmount)
      // destroyIfAny();
    };
  }, [
    loading,
    hasNoData,
    tableRows,           // data set
    baseRows.length,     // toggles emptyTable text
    selectedModes,
    useScroller,
    height,
    pageLength,
    onRowClick,
    onSelectCoords,
  ]);

  // UI states managed here
  if (loading) {
    return (
      <div className="w-full" style={{ height, display: "grid", placeItems: "center", opacity: 0.85 }}>
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
      <style>{tableStyles}</style>
    </div>
  );
});

export default FeatureTable;
