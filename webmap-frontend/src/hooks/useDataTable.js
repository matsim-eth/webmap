/**
 * DataTables lifecycle + search effects, lifted out of FeatureTable.jsx so
 * the component shell stays declarative. jQuery DataTables is imperative —
 * init/destroy/update happens via the DT instance, not via React rendering
 * — and the no-useEffect rule explicitly allows useEffect inside hooks
 * under `src/hooks/`.
 *
 * Three hooks:
 *   - `useDataTable`            — fresh init / fast-path row update / destroy
 *   - `useDataTableSearch`      — pushes the toolbar search state into DT
 *                                 (numeric comparisons, modes/stop-name
 *                                 partial match, accent expansion)
 *   - `useTableFilterQuerySync` — mirrors the toolbar search to the
 *                                 `tableFilterQuery` context the modules
 *                                 read for map-side filtering
 */

import { useEffect, useRef } from 'react';
import $ from 'jquery';
import { NUMERIC_SEARCH_COLS } from '../components/table/_lib/columns';
import { normalizeAccents } from '../components/table/_lib/buildRows';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Init / update / destroy a DataTables instance bound to `tableRef.current`.
 * Returns the dtRef so sibling hooks (search, exporters) can read it.
 *
 * Re-init is avoided when the row data changes — `instance.clear()` +
 * `rows.add()` is much cheaper. We only fall back to a full destroy when
 * the underlying instance has been invalidated (e.g. parent unmounted the
 * <table> while this effect was queued) or `loading`/`hasNoData` flips.
 */
export function useDataTable({
  tableRef,
  rows,
  baseRowsCount,
  columns,
  useScroller,
  height,
  pageLength,
  initialOrder,
  loading,
  hasNoData,
  onRowClick,
  onSelectCoords,
}) {
  const dtRef = useRef(null);
  const pluginsLoadedRef = useRef({ scroller: false });

  // effect:audited — jQuery DataTables lifecycle (init/destroy/update) requires imperative DOM sync
  useEffect(() => {
    let cancelled = false;
    const el = tableRef.current;

    const destroyIfAny = () => {
      try {
        dtRef.current?.destroy(true);
      } catch {}
      dtRef.current = null;
      if (el?._dt) {
        try {
          el._dt.destroy(true);
        } catch {}
        el._dt = null;
      }
      if (el?._dtResizeObserver) {
        try { el._dtResizeObserver.disconnect(); } catch {}
        el._dtResizeObserver = null;
      }
      if (el?._dtAdjustTimers) {
        el._dtAdjustTimers.forEach((id) => clearTimeout(id));
        el._dtAdjustTimers = null;
      }
    };

    if (loading || hasNoData) {
      destroyIfAny();
      if (el) el.innerHTML = "";
      return;
    }

    const init = async () => {
      if (!el) return;

      // Scroller is the only DT plugin we need (no Buttons — we ship our
      // own toolbar + CSV exporter to avoid the extra ~30kB).
      if (useScroller && !pluginsLoadedRef.current.scroller) {
        await import("datatables.net-scroller");
        await import("datatables.net-scroller-dt/css/scroller.dataTables.css");
        pluginsLoadedRef.current.scroller = true;
      }
      if (cancelled) return;

      // Fast path: existing instance — clear + add rows instead of destroy.
      if (dtRef.current && el._dt) {
        const instance = dtRef.current;
        try {
          if (!instance.settings || !instance.settings()[0]) {
            throw new Error("Table instance invalid");
          }
          instance.clear();
          instance.rows.add(rows.map((r) => ({ ...r })));
          if (instance.settings()[0]) {
            instance.draw(false);
          }
        } catch (e) {
          console.warn("Table update failed, reinitializing:", e);
          destroyIfAny();
        }
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
        data: rows,
        columns,
        autoWidth: false,
        order: initialOrder,
        // Our own toolbar replaces DT's built-in filter ('f')
        dom: useScroller ? "rti" : "rtip",
        ...(useScroller
          ? { scrollY: height, scroller: true, paging: true, deferRender: true }
          : { paging: true, pageLength }),
        rowId: (row) =>
          row.rowKey || `row-${row.tableId}-${row.directionId ?? "all"}`,
        language: {
          emptyTable: baseRowsCount
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

        [...tr.parentElement.children].forEach((r) =>
          r.classList.remove("row-selected")
        );
        tr.classList.add("row-selected");

        onRowClick?.(rowData);
        onSelectCoords?.(rowData.coords ?? null, rowData);
      };
      el.addEventListener("click", onClick);

      dtRef.current = instance;
      el._dt = instance;

      // Column-alignment guard.
      //
      // The table mounts inside the right sidebar whose width animates
      // (0.3s ease). DataTables / Scroller measure the scroll-body width
      // at init; if that happens mid-transition the header columns end up
      // narrower than the body and don't realign until the user clicks a
      // sort header (which forces a redraw). Re-measure once layout has
      // settled, and again on any subsequent resize of the wrapper.
      const adjust = () => {
        try {
          if (!instance.settings || !instance.settings()[0]) return;
          instance.columns.adjust();
          if (useScroller && instance.scroller && typeof instance.scroller.measure === 'function') {
            instance.scroller.measure(false);
          }
        } catch {}
      };

      el._dtAdjustTimers = [
        setTimeout(adjust, 0),
        setTimeout(adjust, 50),
        setTimeout(adjust, 350),  // ~ sidebar transition end
      ];

      const wrapper = el.closest('.dataTables_wrapper') || el.parentElement;
      if (wrapper && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => adjust());
        ro.observe(wrapper);
        el._dtResizeObserver = ro;
      }
    };

    init();

    return () => {
      cancelled = true;
      // Intentionally keep the instance alive across re-renders so the
      // fast-path update can run on next data change.
    };
    // `initialOrder` and `tableRef` are intentionally omitted: the order is
    // applied only at fresh init (changing it later would jarringly
    // re-sort), and `tableRef` is a useRef object whose identity is stable
    // anyway — including either would force the effect to re-run on every
    // FeatureTable re-render and re-build the DataTable on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    hasNoData,
    rows,
    baseRowsCount,
    columns,
    useScroller,
    height,
    pageLength,
    onRowClick,
    onSelectCoords,
  ]);

  return dtRef;
}

/**
 * Push the toolbar search state into the DataTables instance. Three
 * branches: numeric comparison filter (`>100`), Transit accent-aware
 * partial match, and the default exact/contains regex.
 */
export function useDataTableSearch({
  dtRef,
  searchCol,           // -1 = all columns
  debouncedSearch,     // string, debounced
  searchText,          // string, raw (only used to short-circuit blank input)
  dtColumns,
  selectedGraph,
  tableRows,           // included as a dep so search re-runs on data refresh
}) {
  // effect:audited — jQuery DataTables search API requires imperative calls synced to React state
  useEffect(() => {
    const instance = dtRef.current;
    if (!instance) return;

    try {
      const settings = instance.settings();
      if (!settings || !settings[0]) return;

      // Skip while DT is mid-processing — race on `redraw` causes
      // `Node.removeChild` errors via Scroller.
      const api = instance.settings()[0];
      if (api && api.bProcessing) return;

      // Drop any comparison filter left over from a previous query; they
      // live on the global `$.fn.dataTable.ext.search` array.
      $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
        (fn) => fn._isComparisonFilter !== true
      );

      try {
        instance.columns().every(function () {
          this.search("");
        });
        instance.search("");
      } catch (e) {
        console.warn("Failed to clear search:", e);
        return;
      }

      const raw = (searchText || "").trim();
      if (!raw) {
        try {
          instance.draw(false);
        } catch (e) {
          console.warn("Draw failed:", e);
        }
        return;
      }

      const selectedTitle =
        Number.isInteger(searchCol) && searchCol >= 0
          ? (dtColumns[searchCol]?.title || "").toLowerCase()
          : "";

      const isNumericCol =
        searchCol >= 0 &&
        NUMERIC_SEARCH_COLS.has(dtColumns[searchCol]?.data || "");

      // Numeric comparison: >, <, >=, <=  (numeric columns only, never "All")
      if (isNumericCol && /^(>=?|<=?)\s*[0-9.,]+$/.test(raw)) {
        const match = raw.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
        if (match) {
          const operator = match[1];
          const value = parseFloat(match[2].replace(/,/g, ""));

          if (!isNaN(value)) {
            $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
              (fn) => fn._isComparisonFilter !== true
            );

            const filterFn = function (s, data, dataIndex) {
              if (s.nTable !== instance.table().node()) return true;
              if (!data || !s.aoData || !s.aoData[dataIndex]) return false;

              const cellValue = parseFloat(data[searchCol]);
              if (isNaN(cellValue)) return false;

              switch (operator) {
                case ">":  return cellValue >  value;
                case "<":  return cellValue <  value;
                case ">=": return cellValue >= value;
                case "<=": return cellValue <= value;
                default:   return true;
              }
            };
            filterFn._isComparisonFilter = true;

            $.fn.dataTable.ext.search.push(filterFn);

            try {
              instance.draw(false);
            } catch (e) {
              console.warn("Draw failed during comparison filter:", e);
              $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
                (fn) => fn._isComparisonFilter !== true
              );
            }
            return;
          }
        }
      }

      // Multi-term split on `,` or `;`
      const terms = raw
        .split(/[;,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (terms.length === 0) {
        instance.draw(false);
        return;
      }

      // Exact-match for ID-style columns; contains for modes / stop name /
      // "All columns" (so the user can type a partial mode list).
      const colIsExact =
        Number.isInteger(searchCol) &&
        searchCol >= 0 &&
        selectedTitle !== "modes" &&
        selectedTitle !== "stop name";

      let pattern;
      if (isNumericCol) {
        // Numeric columns: strip commas, exact-match the number form
        const numTerms = terms
          .map((t) => t.replace(/,/g, ""))
          .filter((t) => !isNaN(Number(t)));
        pattern = numTerms.length
          ? `^(${numTerms.join("|")})$`
          : terms.map(escapeRegex).join("|");
      } else if (
        selectedTitle === "modes" ||
        selectedTitle === "stop name" ||
        searchCol === -1
      ) {
        // For Transit Stop Name / All columns, expand each term into the
        // accent-normalized variant so `geneve` matches `Genève`.
        if (
          selectedGraph === "Transit" &&
          (selectedTitle === "stop name" || searchCol === -1)
        ) {
          const expandedTerms = terms.flatMap((t) => {
            const normalized = normalizeAccents(t);
            return t === normalized
              ? [escapeRegex(t)]
              : [escapeRegex(t), escapeRegex(normalized)];
          });
          pattern = expandedTerms.join("|");
        } else {
          pattern = terms.map(escapeRegex).join("|");
        }
      } else {
        pattern = terms.map(escapeRegex).join("|");
      }

      const finalPattern = colIsExact ? `^(?:${pattern})$` : `(?:${pattern})`;

      if (Number.isInteger(searchCol) && searchCol >= 0) {
        instance
          .column(searchCol)
          .search(finalPattern, /* regex */ true, /* smart */ false);
      } else {
        instance.search(finalPattern, /* regex */ true, /* smart */ false);
      }

      try {
        instance.draw(false);
      } catch (e) {
        console.warn("Draw failed during search:", e);
      }
    } catch (error) {
      console.warn("Search operation failed:", error);
      if (instance.settings && instance.settings()[0]) {
        try {
          instance.search("").draw(false);
        } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCol, debouncedSearch, tableRows, dtColumns, selectedGraph]);
}

/**
 * Mirror the toolbar search to the `tableFilterQuery` context the module
 * map-filter hooks consume. Emits `null` on blank input so downstream
 * filters reset to the full set.
 */
export function useTableFilterQuerySync({
  searchCol,
  debouncedSearch,
  searchText,
  dtColumns,
  setTableFilterQuery,
}) {
  // effect:audited — syncs DataTables search state to parent map filter query
  useEffect(() => {
    const raw = (searchText || "").trim();
    if (!raw) {
      setTableFilterQuery?.(null);
      return;
    }

    let column = null;
    if (Number.isInteger(searchCol) && searchCol >= 0) {
      column = dtColumns[searchCol]?.data || null;
    }
    setTableFilterQuery?.({ column, value: raw });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, searchCol]);
}
