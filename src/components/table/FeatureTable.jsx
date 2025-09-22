// src/components/table/FeatureTable.jsx
import React, { useEffect, useMemo, useRef } from "react";

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

// Cheap mode match: use precomputed array if present
const modeMatches = (row, selectedModes) => {
  if (!Array.isArray(selectedModes) || selectedModes.length === 0 || selectedModes.includes("all")) return true;
  const arr = row.modesArr || String(row.modes || "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!arr.length) return false;
  return selectedModes.some((m) => arr.includes(m));
};

// Compute bbox instead of storing full coords (less memory)
const bboxFromGeometry = (g) => {
  if (!g) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const walk = (coords) => {
    // coords can be [lng,lat], array of points, or nested arrays
    if (!Array.isArray(coords)) return;
    if (coords.length === 0) return;
    if (typeof coords[0] === "number" && coords.length >= 2) {
      const lng = coords[0], lat = coords[1];
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    } else {
      for (const c of coords) walk(c);
    }
  };
  walk(g.coordinates);
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
};

// Faster builder: preformats display fields, builds modesArr, stores bbox
const buildRowsFromGeojsonFast = (geojson) => {
  if (!geojson?.features) return [];
  const out = [];
  for (let i = 0; i < geojson.features.length; i++) {
    const feature = geojson.features[i];
    const props = feature?.properties || {};
    // Avoid try/catch cost unless it looks like JSON
    let per = props.per_id;
    if (typeof per === "string" && per.length && per[0] === "{") {
      try { per = JSON.parse(per); } catch { per = {}; }
    }
    if (!per || typeof per !== "object" || Array.isArray(per)) per = {};

    const tableId = Number(props.__tableId ?? i);
    const segmentLabel =
      props.id ?? props.link_id ?? props.segment_id ?? props.objectid ?? props.osm_id ?? `Segment ${i + 1}`;

    const modesStr = props.modes || "";
    const modesArr = modesStr ? modesStr.split(",").map((m) => m.trim()).filter(Boolean) : [];

    const bbox = bboxFromGeometry(feature?.geometry);

    const pushRow = (directionId, data = {}) => {
      const length = num(data.length ?? props.length);
      const freeSpeed = toKmh(data.freespeed ?? props.freespeed);
      const capacity = num(data.capacity ?? props.capacity);
      const dailyAvg = num(data.daily_avg_volume ?? props.daily_avg_volume);

      out.push({
        rowKey: `${tableId}-${directionId ?? "all"}-${out.length}`,
        tableId,
        segmentLabel,
        directionId: directionId ?? null,

        // raw values (optional)
        length,
        freeSpeed,
        capacity,
        dailyAvg,

        // preformatted display strings (kill per-cell render cost)
        length_fmt: fmt(length, 1),
        freeSpeed_fmt: fmt(freeSpeed, 1),
        capacity_fmt: fmt(capacity),
        dailyAvg_fmt: fmt(dailyAvg),

        modes: modesStr,
        modesArr,

        // use bbox instead of storing all coords
        bbox,

        // keep feature references OUT to reduce memory; re-acquire on click if needed
        // feature,
      });
    };

    const entries = Object.entries(per);
    if (entries.length) {
      for (const [dir, d] of entries) pushRow(dir, d || {});
    } else {
      pushRow(null, {});
    }
  }
  return out;
};

/* ---------------- component ---------------- */
const FeatureTable = ({
  geojson,                 // optional
  rows,                    // optional (wins over geojson)
  selectedModes = ["all"],
  onRowClick,              // (row) => void
  onSelectCoords,          // (coordsOrBbox, row) => void
  tableId = "feature-table",
  height = 360,
  useScroller = true,
  showButtons = true,
  pageLength = 25,
  maxRows = 75000,
  loading = false,
}) => {
  const tableRef = useRef(null);
  const dtRef = useRef(null);
  const pluginsLoadedRef = useRef({ buttons: false, scroller: false });

  // Build rows once per input, fast path
  const baseRows = useMemo(() => {
    if (Array.isArray(rows) && rows.length) return rows;
    const built = buildRowsFromGeojsonFast(geojson);
    return built;
  }, [rows, geojson]);

  // Filter & limit
  const tableRows = useMemo(() => {
    // cheap filtering using modesArr
    const filtered = baseRows.filter((r) => modeMatches(r, selectedModes));
    return filtered.slice(0, maxRows);
  }, [baseRows, selectedModes, maxRows]);

  const hasNoData = tableRows.length === 0;

  useEffect(() => {
    let cancelled = false;

    // Tear down if loading/no data
    const ensureDestroyed = () => {
      const el = tableRef.current;
      try { dtRef.current?.destroy(true); } catch {}
      dtRef.current = null;
      if (el?._dt) { try { el._dt.destroy(true); } catch {} el._dt = null; }
    };

    if (loading || hasNoData) {
      ensureDestroyed();
      const el = tableRef.current;
      if (el) el.innerHTML = "";
      return;
    }

    const init = async () => {
      const el = tableRef.current;
      if (!el) return;

      // Load plugins once per app session
      if (showButtons && !pluginsLoadedRef.current.buttons) {
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

      const columns = [
        { data: "segmentLabel", title: "Segment IDs" },
        { data: "directionId",  title: "Direction" },
        { data: "length_fmt",   title: "Length (m)" },
        { data: "freeSpeed_fmt",title: "Free Speed (km/h)" },
        { data: "capacity_fmt", title: "Capacity" },
        { data: "dailyAvg_fmt", title: "Avg Daily Volume" },
        { 
          data: "modes",
          title: "Modes",
          render: (v) => (v ? String(v).replace(/,/g, ", ") : "-"),
        },
      ];

      // If already initialized, just update data (faster than destroy/reinit)
      if (dtRef.current && el._dt) {
        const instance = dtRef.current;
        instance.clear();
        instance.rows.add(tableRows);
        instance.draw(false);
        return;
      }

      // Fresh init
      el.innerHTML = `
        <thead>
          <tr>${columns.map(c => `<th>${c.title}</th>`).join("")}</tr>
        </thead>
        <tbody></tbody>
      `;

      const instance = $(el).DataTable({
        data: tableRows,
        columns,
        autoWidth: false,
        order: [[0, "asc"]],
        dom: showButtons ? (useScroller ? "Bfrti" : "Bfrtip") : (useScroller ? "frti" : "frtip"),
        buttons: showButtons
          ? [
              { extend: "copyHtml5", title: "network_segments" },
              { extend: "csvHtml5",  title: "network_segments" },
            ]
          : [],
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
        info: false, // cut some DOM work; set true if you want the "Showing X of Y" text
      });

      // Row click handler
      const onClick = (e) => {
        const tr = e.target.closest("tr");
        if (!tr || !tr.closest("tbody")) return;
        const rowData = instance.row(tr).data();
        if (!rowData) return;

        // selection styling
        [...tr.parentElement.children].forEach((r) => r.classList.remove("row-selected"));
        tr.classList.add("row-selected");

        onRowClick?.(rowData);

        // Prefer bbox for fitBounds (lighter than coords)
        onSelectCoords?.(rowData.bbox ?? null, rowData);
      };
      el.addEventListener("click", onClick);

      dtRef.current = instance;
      el._dt = instance;

      return () => el.removeEventListener("click", onClick);
    };

    init();

    return () => {
      cancelled = true;
      // Do not destroy here unconditionally — allow reuse path above to be fast
    };
  }, [
    loading,
    hasNoData,
    tableRows,       // data set
    baseRows.length, // language/emptyTable toggle
    selectedModes,
    useScroller,
    height,
    pageLength,
    showButtons,
    onRowClick,
    onSelectCoords,
  ]);

  // UI states handled here
  if (loading) {
    return (
      <div className="w-full" style={{ height, display: "grid", placeItems: "center", opacity: 0.85 }}>
        <span>Preparing table…</span>
      </div>
    );
  }

  if (hasNoData) {
    return (
      <div className="w-full" style={{ height, display: "grid", placeItems: "center", color: "#888", fontStyle: "italic" }}>
        <span>No segment data available</span>
      </div>
    );
  }

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
