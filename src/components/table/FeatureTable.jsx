// src/components/table/FeatureTable.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
} from "react";

import $ from "jquery";
import dt from "datatables.net-dt";
import "datatables.net-dt/css/dataTables.dataTables.css";

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

/* ---------------- helpers ---------------- */

// conver to number
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// match row modes against selected modes
const modeMatches = (rowModes, selectedModes) => {
  if (
    !Array.isArray(selectedModes) ||
    selectedModes.length === 0 ||
    selectedModes.includes("all")
  )
  return true;
  const modes = String(rowModes || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
  if (!modes.length) return false;
  return selectedModes.some((m) => modes.includes(m));
};

// CSV helpers
const csvEscape = (v) => {
  const s = v == null ? "" : String(v);
  // if contains comma, quote, newline, wrap in double quotes and escape internal quotes
  // ie used to keep list of modes in one cell even though its comma-separated
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/** Faster: precompute formatted strings once per row; keep raw numbers for sort */
export const buildRowsFromGeojson = (geojson, selectedGraph = null) => {
  if (!geojson.features) return [];
  
  const rows = [];
  geojson.features.forEach((feature, featureIndex) => {
    const props = feature?.properties || {};
    
    // Parse pipe-separated strings into arrays
    const keys = (props.per_id_keys || "").split("|").filter(Boolean);
    const capacities = (props.per_id_capacities || "").split("|").filter(Boolean);
    const lengths = (props.per_id_lengths || "").split("|").filter(Boolean);
    const freespeeds = (props.per_id_freespeeds || "").split("|").filter(Boolean);
    const daily_avgs = (props.per_id_daily_avgs || "").split("|").filter(Boolean);
    const arrows = (props.per_id_arrows || "").split("|").filter(Boolean);
    const directions = (props.per_id_directions || "").split("|").filter(Boolean);
    
    // allocate a tableId for rowKey generation
    const tableId = Number(featureIndex);
    
    // coords for map zoom
    const g = feature?.geometry;
    const coords =
    g.type === "LineString"
    ? g.coordinates
    : g.type === "MultiLineString"
    ? g.coordinates.flat()
    : null;
    
    const roundTo = (value, decimals = 0) => {
      if (!Number.isFinite(value)) return value;
      const factor = Math.pow(10, decimals);
      return Math.round(value * factor) / factor;
    };
    
    const pushRow = (index) => {
      const directionId = keys[index] || null;
      const length = num(lengths[index]);
      const freeSpeed = num(freespeeds[index]);
      const capacity = num(capacities[index]);
      const arrow = arrows[index] || null;
      const direction = directions[index] || null;
      
      // For TransitVolumes, use directional total volumes; otherwise use daily_avgs
      let totalVol;
      if (selectedGraph === 'TransitVolumes') {
        if (arrow === '←') {
          totalVol = props.total_left;
        } else if (arrow === '→') {
          totalVol = props.total_right;
        } else {
          totalVol = props.total_volume; // fallback to combined if no arrow
        }
      } else {
        totalVol = num(daily_avgs[index]);
      }
      
      // Calculate filtered volume for Volumes and TransitVolumes modules
      let filteredVolume = null;
      if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
        if (arrow === '←') {
          // Left arrow = left_sum
          filteredVolume = num(props.left_sum);
        } else if (arrow === '→') {
          // Right arrow = right_sum
          filteredVolume = num(props.right_sum);
        }
      }
      
      // Calculate total capacity for the feature (sum of all directions)
      let totalCapacity = 0;
      capacities.forEach(cap => {
        const c = num(cap);
        if (c !== null) totalCapacity += c;
      });
      
      rows.push({
        rowKey: `${tableId}-${directionId ?? "all"}-${rows.length}`,
        tableId,
        directionId: directionId ?? null,
        length: length ? roundTo(length, 1) : length, // Round to 1 decimal
        freeSpeed: freeSpeed ? roundTo(freeSpeed, 1) : freeSpeed,
        capacity,
        totalCapacity, // sum of both directions
        totalVol,
        filteredVolume: filteredVolume ? roundTo(filteredVolume, 1) : filteredVolume,
        modes: props.modes || "",
        coords,
        feature,
        featureProps: props,
        arrow,
        direction
      });
    };
    
    // Create a row for each direction
    if (keys.length > 0) {
      keys.forEach((_, index) => pushRow(index));
    } else {
      // Fallback if no per_id data
      pushRow(0);
    }
  });
  return rows;
};

/* ---------------- component ---------------- */
const FeatureTable = forwardRef(
  (
    {
      selectedGraph,
      geojson, // optional
      rows, // optional (wins over geojson)
      selectedModes = ["all"],
      onRowClick, // (row) => void
      onSelectCoords, // (coords, row) => void
      tableId = "feature-table",
      height = 360, // used for Scroller
      useScroller = true, // true: virtual scroll; false: regular paging
      pageLength = 25,
      maxRows = 300000,
      loading = false,
      setTableFilterQuery,
      showMajorRoadsOnly = false // filter by capacity > 1200
    },
    ref
  ) => {
    const tableRef = useRef(null);
    const dtRef = useRef(null);
    const pluginsLoadedRef = useRef({ scroller: false });
    
    const tableStyles = useMemo(
      () => `
          .row-selected{background-color:rgba(0,123,255,.12)!important;}
          #${tableId}_wrapper .dt-buttons{display:none!important;}
                
          /* Hide the built-in filter; we provide our own toolbar */
          #${tableId}_wrapper .dataTables_filter{display:none!important;}
                
          /* Custom toolbar */
          #${tableId}-toolbar{
            display:flex; align-items:center; gap:.5rem; margin:0 0 .5rem 0;
            font-size:12px;
          }
          #${tableId}-toolbar select{
            height:28px; padding:2px 6px;
          }
          #${tableId}-toolbar input{
            height:28px; padding:2px 6px; min-width:220px;
          }
          #${tableId}-toolbar button{
            height:28px; padding:2px 8px;
          }
          `,
      [tableId]
    );
    
    const baseRows = useMemo(() => {
      if (loading) return [];
      if (Array.isArray(rows) && rows.length) return rows;
      const built = buildRowsFromGeojson(geojson, selectedGraph);
      if (built.length) return built;
      return [];
    }, [loading, rows, geojson, selectedGraph]);
    
    const tableRows = useMemo(() => {
      let filtered = baseRows.filter((r) => modeMatches(r.modes, selectedModes));
      
      // Apply major roads filter (totalCapacity > 1200)
      if (showMajorRoadsOnly) {
        filtered = filtered.filter((r) => {
          const totalCap = Number(r.totalCapacity);
          return Number.isFinite(totalCap) && totalCap > 1200;
        });
      }
      
      return filtered.slice(0, maxRows);
    }, [baseRows, selectedModes, maxRows, showMajorRoadsOnly]);
    
    const hasNoData = tableRows.length === 0;
    
    // Single source of truth for columns (used by DT and the toolbar + exporter)
    const columnDefs = useMemo(
      () => {
        
        const cols = [
          { key: "directionId", title: "Link ID" },
          { key: "length", title: "Length [m]" },        
          { key: "freeSpeed", title: "Speed [km/h]" },   
          { key: "capacity", title: "Capacity" },
          { key: "totalVol", title: "Total Daily Volume" },
        ];
        
        // Add filtered volume column for Volumes and TransitVolumes modules
        if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
          cols.push({ key: "filteredVolume", title: "Filtered Volume" });
        }
        
        cols.push({
          key: "modes",
          title: "Modes",
          render: (v) => (v ? String(v).replace(/,/g, ", ") : "-"),
        });
        
        return cols;
      },
      [selectedGraph]
    );
    
    // Simple debounce hook
    const useDebounced = (value, delay = 200) => {
      const [debounced, setDebounced] = useState(value);
      useEffect(() => {
        const handler = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(handler);
      }, [value, delay]);
      return debounced;
    };
    
    // DataTables columns (maps to the same keys)
    const dtColumns = useMemo(
      () => {
        const cols = [
          { data: "directionId", title: "Link ID" },
          { data: "length", title: "Length [m]" },
          { data: "freeSpeed", title: "Speed [km/h]" },
          { data: "capacity", title: "Capacity" },
          { data: "totalVol", title: "Total Daily Volume" },
        ];
        
        // Add filtered volume column for Volumes and TransitVolumes modules
        if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
          cols.push({ data: "filteredVolume", title: "Filtered Volume" });
        }
        
        cols.push({
          data: "modes",
          title: "Modes",
          render: (v) => (v ? String(v).replace(/,/g, ", ") : "-"),
        });
        
        return cols;
      },
      [selectedGraph]
    );
    
    
    // Toolbar state
    const [searchCol, setSearchCol] = useState(-1); // -1 = all columns
    const [searchText, setSearchText] = useState("");
    const debouncedSearch = useDebounced(searchText, 180);
    
    // Expose a native CSV exporter (no Buttons dependency)
    useImperativeHandle(ref, () => ({
      exportCsv: () => {
        const instance = dtRef.current;
        if (!instance) return false;
        
        // Get rows currently in the table view (respecting search/filter)
        const dataArr = instance.rows({ search: "applied" }).data().toArray();
        if (!dataArr.length) return false;
        
        // Build CSV header
        const header = columnDefs.map((c) => csvEscape(c.title)).join(",");
        
        // Build CSV rows (use displayed values; apply render for modes)
        const lines = dataArr.map((row) => {
          return columnDefs
          .map((c) => {
            let val;
            if (c.key === "modes") {
              val = c.render ? c.render(row.modes) : row.modes;
            } else {
              val = row[c.key];
            }
            return csvEscape(val);
          })
          .join(",");
        });
        
        const csv = [header, ...lines].join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const fname = `${tableId}_export.csv`;
        downloadBlob(blob, fname);
        return true;
      },
    }));
    
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
      };
      
      // If loading or no data, tear down and skip
      if (loading || hasNoData) {
        destroyIfAny();
        if (el) el.innerHTML = "";
        return;
      }
      
      const init = async () => {
        if (!el) return;
        
        // Load only Scroller (no Buttons needed for column search/export)
        if (useScroller && !pluginsLoadedRef.current.scroller) {
          await import("datatables.net-scroller");
          await import("datatables.net-scroller-dt/css/scroller.dataTables.css");
          pluginsLoadedRef.current.scroller = true;
        }
        if (cancelled) return;
        
        // Fast path: if already initialized, update rows only
        if (dtRef.current && el._dt) {
          const instance = dtRef.current;
          try {
            // Check if table is still valid before operations
            if (!instance.settings || !instance.settings()[0]) {
              throw new Error("Table instance invalid");
            }
            
            instance.clear();
            instance.rows.add(
              tableRows.map((r) => ({
                ...r,
              }))
            );
            
            // Safe redraw guard with additional checks
            if (instance.settings()[0]) {
              instance.draw(false);
            }
          } catch (e) {
            console.warn("Table update failed, reinitializing:", e);
            // Force reinitialization if update fails
            destroyIfAny();
          }
          
          return;
        }
        
        
        // Fresh init: build header once
        el.innerHTML = `
          <thead>
            <tr>${dtColumns.map((c) => `<th>${c.title}</th>`).join("")}</tr>
          </thead>
          <tbody></tbody>
        `;
        
        const instance = $(el).DataTable({
          data: tableRows,
          columns: dtColumns,
          autoWidth: false,
          order: [[0, "asc"]],
          // Remove built-in filter ('f'); we'll use our custom toolbar
          dom: useScroller ? "rti" : "rtip",
          ...(useScroller
            ? { scrollY: height, scroller: true, paging: true, deferRender: true }
            : { paging: true, pageLength }),
            rowId: (row) =>
              row.rowKey || `row-${row.tableId}-${row.directionId ?? "all"}`,
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
        
        return () => {
          el.removeEventListener("click", onClick);
        };
      };
      
      init();
      
      return () => {
        cancelled = true;
        // keep instance for fast updates
      };
    }, [
      loading,
      hasNoData,
      tableRows, // data set
      baseRows.length, // toggles emptyTable text
      selectedModes,
      useScroller,
      height,
      pageLength,
      onRowClick,
      onSelectCoords,
      dtColumns,
    ]);
    
    // Multi-term search (comma/semicolon separated)
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    
    // Apply search whenever search state or rows change
    useEffect(() => {
      const instance = dtRef.current;
      if (!instance) return;
      
      // Add safety check to prevent operations on destroyed table
      try {
        const settings = instance.settings();
        if (!settings || !settings[0]) return;
        
        // Check if table is currently processing - if so, skip this search
        const api = instance.settings()[0];
        if (api && api.bProcessing) {
          return;
        }
        
        // Clear any comparison filters from previous searches
        $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
          fn => fn._isComparisonFilter !== true
        );
        
        // Clear previous searches - wrap in try-catch
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
        
        // Determine column info
        const selectedTitle =
        Number.isInteger(searchCol) && searchCol >= 0
        ? (dtColumns[searchCol]?.title || "").toLowerCase()
        : "";
        
        // Only allow comparison operators for specific numeric columns (not "All columns")
        const isNumericCol = searchCol >= 0 && ["capacity", "length", "freeSpeed", "totalVol", "filteredVolume"].includes(
          dtColumns[searchCol]?.data || ""
        );
        
        // Check for comparison operators (>, <, >=, <=) in numeric columns
        if (isNumericCol && /^(>=?|<=?)\s*[0-9.,]+$/.test(raw)) {
          const match = raw.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
          if (match) {
            const operator = match[1];
            const value = parseFloat(match[2].replace(/,/g, ''));
            
            if (!isNaN(value)) {
              // Clear any existing custom filters first
              $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
                fn => fn._isComparisonFilter !== true
              );
              
              // Use custom filter function for comparisons
              const filterFn = function(settings, data, dataIndex) {
                if (settings.nTable !== instance.table().node()) return true;
                
                // Safety check: ensure the row data exists
                if (!data || !settings.aoData || !settings.aoData[dataIndex]) return false;
                
                const cellValue = parseFloat(data[searchCol]);
                if (isNaN(cellValue)) return false;
                
                switch(operator) {
                  case '>': return cellValue > value;
                  case '<': return cellValue < value;
                  case '>=': return cellValue >= value;
                  case '<=': return cellValue <= value;
                  default: return true;
                }
              };
              filterFn._isComparisonFilter = true;
              
              $.fn.dataTable.ext.search.push(filterFn);
              
              try {
                instance.draw(false);
              } catch (e) {
                console.warn("Draw failed during comparison filter:", e);
                // Remove the problematic filter and try again
                $.fn.dataTable.ext.search = $.fn.dataTable.ext.search.filter(
                  fn => fn._isComparisonFilter !== true
                );
              }
              
              return;
            }
          }
        }
        
        // Original logic for non-comparison searches
        // Split on comma or semicolon, trim, drop empties
        const terms = raw
        .split(/[;,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
        if (terms.length === 0) {
          instance.draw(false);
          return;
        }
        
        // Build regex pattern:
        // For numeric columns, search against raw values, not formatted ones
        
        // Exact match logic:
        // - Link ID column: exact match
        // - Other specific columns: exact match  
        // - Modes column: contains match
        // - ALL COLUMNS search: contains match
        const colIsExact = Number.isInteger(searchCol) && searchCol >= 0 && selectedTitle !== "modes";
        
        let pattern;
        if (isNumericCol) {
          // For numeric columns, convert comma-separated numbers and create exact matches
          const numTerms = terms.map(t => t.replace(/,/g, '')).filter(t => !isNaN(Number(t)));
          pattern = numTerms.length ? `^(${numTerms.join('|')})$` : terms.map(escapeRegex).join("|");
        } else if (selectedTitle === "modes" || searchCol === -1) {
          // Modes column OR all columns search: use contains matching
          pattern = terms.map(escapeRegex).join("|");
        } else {
          // Other specific text columns (like Link ID): use exact matching
          pattern = terms.map(escapeRegex).join("|");
        }
        
        const finalPattern = colIsExact ? `^(?:${pattern})$` : `(?:${pattern})`;
        
        if (Number.isInteger(searchCol) && searchCol >= 0) {
          // Column-specific search
          instance.column(searchCol).search(finalPattern, /* regex */ true, /* smart */ false);
        } else {
          // Global search across all columns
          instance.search(finalPattern, /* regex */ true, /* smart */ false);
        }
        
        try {
          instance.draw(false);
        } catch (e) {
          console.warn("Draw failed during search:", e);
        }
      } catch (error) {
        console.warn("Search operation failed:", error);
        // Optionally clear the search to prevent stuck states
        if (instance.settings && instance.settings()[0]) {
          try {
            instance.search("").draw(false);
          } catch {}
        }
      }
    }, [searchCol, debouncedSearch, tableRows, dtColumns]);
    
    // send the table search query to map to filter features
    useEffect(() => {
      const instance = dtRef.current;
      if (!instance) return;
      
      const raw = (searchText || "").trim();
      if (!raw) {
        setTableFilterQuery?.(null);
        return;
      }
      
      // --- Determine which column is being searched ---
      let column = null;
      
      // If a specific column is selected (not "All columns")
      if (Number.isInteger(searchCol) && searchCol >= 0) {
        const colKey = dtColumns[searchCol]?.data || null;
        column = colKey;
      }
      
      // --- Build and emit query  ---
      const query = { column, value: raw };
      
      setTableFilterQuery?.(query);
    }, [debouncedSearch, searchCol]);
    
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
        style={{
          height,
          display: "grid",
          placeItems: "center",
          color: "#888",
          fontStyle: "italic",
        }}
        >
        <span>No segment data available</span>
        </div>
      );
    }
    
    // Normal DT rendering
    return (
      <div className="w-full" style={{ minHeight: 200 }}>
      {/* Custom toolbar */}
      <div id={`${tableId}-toolbar`}>
      <label>Search in:</label>
      <select
      value={String(searchCol)}
      onChange={(e) => setSearchCol(parseInt(e.target.value, 10))}
      >
      <option value="-1">All columns</option>
      {dtColumns.map((c, idx) => (
        <option key={idx} value={idx}>
        {c.title}
        </option>
      ))}
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
      </div>
      
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
