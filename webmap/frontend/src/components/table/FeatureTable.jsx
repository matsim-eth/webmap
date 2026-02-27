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
  
  // Helper function to normalize accents for French/German
  const normalizeAccents = (str) => {
    if (!str) return '';
    return String(str)
      .replace(/[äàáâã]/gi, 'a')
      .replace(/[ëèéê]/gi, 'e')
      .replace(/[ïìíî]/gi, 'i')
      .replace(/[öòóôõ]/gi, 'o')
      .replace(/[üùúû]/gi, 'u')
      .replace(/[ÿ]/gi, 'y')
      .replace(/[ç]/gi, 'c')
      .replace(/[ñ]/gi, 'n');
  };
  
  const rows = [];
  geojson.features.forEach((feature, featureIndex) => {
    const props = feature?.properties || {};
    
    // Handle Transit stops differently
    if (selectedGraph === 'Transit') {
      // Transit stop data structure
      const stopName = props.name || "Unknown Stop";
      
      // Parse modes_list
      let modesList = [];
      if (typeof props.modes_list === 'string') {
        try {
          modesList = JSON.parse(props.modes_list);
        } catch {
          // If parse fails, try splitting by comma
          modesList = props.modes_list.split(',').map(m => m.trim()).filter(Boolean);
        }
      } else if (Array.isArray(props.modes_list)) {
        modesList = props.modes_list;
      }
      const modes = Array.isArray(modesList) && modesList.length > 0 
        ? modesList.join(", ") 
        : "-";
      
      // Parse line_ids to count number of unique lines
      let lineIds = [];
      if (Array.isArray(props.line_ids)) {
        lineIds = props.line_ids;
      } else if (typeof props.line_ids === 'string') {
        try {
          lineIds = JSON.parse(props.line_ids);
        } catch {
          lineIds = [];
        }
      }
      // Count unique line_ids
      const uniqueLineIds = Array.isArray(lineIds) ? [...new Set(lineIds)] : [];
      const lineCount = uniqueLineIds.length;
      
      // Get volumes directly from feature properties (added by useTransitStops)
      const boardings = props.boardings || 0;
      const alightings = props.alightings || 0;
      
      // Get coordinates
      const g = feature?.geometry;
      const coords = g?.type === "Point" ? g.coordinates : null;
      
      // Create searchable string with pipe-delimited values for "All columns" search
      // Include normalized version for accent-insensitive search
      const searchString = [
        stopName,
        normalizeAccents(stopName),
        modes,
        String(lineCount),
        String(boardings),
        String(alightings)
      ].join('|');
      
      rows.push({
        rowKey: `transit-stop-${featureIndex}`,
        tableId: featureIndex,
        stopName,
        modes,
        lineCount,
        boardings,
        alightings,
        searchString, // Add searchable string
        coords,
        feature,
        featureProps: props
      });
      
      return; // Skip the rest of the loop for Transit stops
    }
    
    // Parse pipe-separated strings into arrays (for Network/Volumes/TransitVolumes)
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
          #${tableId}_wrapper, #${tableId}_wrapper th, #${tableId}_wrapper td{font-family:Inter,sans-serif;}
          #${tableId}_wrapper th{font-weight:600;}
          .row-selected{background-color:rgba(99,102,241,.12)!important;}
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

          /* Search guide tooltip */
          .search-guide-wrapper{
            position:relative; display:inline-flex; align-items:center;
          }
          .search-guide-icon{
            display:inline-flex; align-items:center; justify-content:center;
            width:18px; height:18px; border-radius:50%;
            border:1.5px solid #9ca3af; color:#6b7280;
            font-size:11px; font-weight:700; font-style:italic;
            font-family:Georgia,serif; cursor:help; user-select:none;
            line-height:1;
          }
          .search-guide-wrapper:hover .search-guide-icon{
            border-color:#6366f1; color:#6366f1;
          }
          .search-guide-tooltip{
            display:none; position:absolute; right:0; top:calc(100% + 8px);
            width:310px; padding:10px 12px;
            background:#1f2937; color:#f3f4f6; border-radius:8px;
            font-size:11.5px; line-height:1.5; z-index:9999;
            box-shadow:0 4px 12px rgba(0,0,0,.25);
          }
          .search-guide-tooltip::before{
            content:''; position:absolute; right:4px; bottom:100%;
            border:6px solid transparent; border-bottom-color:#1f2937;
          }
          .search-guide-wrapper:hover .search-guide-tooltip{
            display:block;
          }
          .search-guide-tooltip hr{
            border:none; border-top:1px solid #4b5563; margin:6px 0;
          }
          .search-guide-tooltip p{
            margin:4px 0;
          }
          .search-guide-tooltip ul{
            margin:2px 0 4px 16px; padding:0;
          }
          .search-guide-tooltip li{
            margin:1px 0;
          }
          .search-guide-tooltip code{
            background:#374151; padding:1px 4px; border-radius:3px;
            font-size:11px;
          }
          .search-guide-tooltip em{
            color:#9ca3af;
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
        // Transit stops have different columns
        if (selectedGraph === 'Transit') {
          return [
            { key: "stopName", title: "Stop Name" },
            { key: "modes", title: "Modes" },
            { key: "lineCount", title: "# Lines" },
            { key: "boardings", title: "Boardings" },
            { key: "alightings", title: "Alightings" },
          ];
        }
        
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
        // Transit stops have different columns
        if (selectedGraph === 'Transit') {
          return [
            { data: "stopName", title: "Stop Name" },
            { data: "modes", title: "Modes" },
            { data: "lineCount", title: "# Lines" },
            { 
              data: "boardings", 
              title: "Boardings",
              render: (data) => Number(data || 0).toLocaleString()
            },
            { 
              data: "alightings", 
              title: "Alightings",
              render: (data) => Number(data || 0).toLocaleString()
            },
            {
              data: "searchString",
              title: "",
              visible: false, // Hidden column for "All columns" search
              searchable: true
            }
          ];
        }
        
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
    
    // Helper function to normalize accents for French/German (for search)
    const normalizeAccents = (str) => {
      if (!str) return '';
      return String(str)
        .replace(/[äàáâã]/gi, 'a')
        .replace(/[ëèéê]/gi, 'e')
        .replace(/[ïìíî]/gi, 'i')
        .replace(/[öòóôõ]/gi, 'o')
        .replace(/[üùúû]/gi, 'u')
        .replace(/[ÿ]/gi, 'y')
        .replace(/[ç]/gi, 'c')
        .replace(/[ñ]/gi, 'n');
    };
    
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
        // Include both Network/Volumes columns and Transit stops columns
        const isNumericCol = searchCol >= 0 && [
          "capacity", "length", "freeSpeed", "totalVol", "filteredVolume", // Network/Volumes
          "lineCount", "boardings", "alightings" // Transit stops
        ].includes(dtColumns[searchCol]?.data || "");
        
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
        // - Stop Name column (Transit): contains match (partial)
        // - ALL COLUMNS search: contains match
        const colIsExact = Number.isInteger(searchCol) && searchCol >= 0 && 
                           selectedTitle !== "modes" && 
                           selectedTitle !== "stop name";
        
        let pattern;
        if (isNumericCol) {
          // For numeric columns, convert comma-separated numbers and create exact matches
          const numTerms = terms.map(t => t.replace(/,/g, '')).filter(t => !isNaN(Number(t)));
          pattern = numTerms.length ? `^(${numTerms.join('|')})$` : terms.map(escapeRegex).join("|");
        } else if (selectedTitle === "modes" || selectedTitle === "stop name" || searchCol === -1) {
          // Modes, Stop Name, OR all columns search: use contains matching
          // For Stop Name or All Columns in Transit, create pattern that matches both original and normalized
          if (selectedGraph === 'Transit' && (selectedTitle === "stop name" || searchCol === -1)) {
            // Create alternation pattern: each term OR its normalized version
            const expandedTerms = terms.flatMap(t => {
              const normalized = normalizeAccents(t);
              return t === normalized ? [escapeRegex(t)] : [escapeRegex(t), escapeRegex(normalized)];
            });
            pattern = expandedTerms.join("|");
          } else {
            pattern = terms.map(escapeRegex).join("|");
          }
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
    }, [searchCol, debouncedSearch, tableRows, dtColumns, selectedGraph]);
    
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
      {dtColumns
        .filter(c => c.title && c.visible !== false) // Filter out empty titles and hidden columns
        .map((c, idx) => {
          // Get the original index from dtColumns
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
          <hr/>
          <p><b>Basic search:</b> type any text to filter rows</p>
          <p><b>Multiple terms:</b> separate with <code>;</code> or <code>,</code> to match any<br/>
            <em>e.g.</em> <code>bus;tram</code></p>
          <p><b>Numeric comparisons</b> (numeric columns only):</p>
          <ul>
            <li><code>&gt;100</code> - greater than</li>
            <li><code>&lt;100</code> - less than</li>
            <li><code>&gt;=100</code> - greater than or equal</li>
            <li><code>&lt;=100</code> - less than or equal</li>
          </ul>
          <p><b>All columns:</b> partial match across every column</p>
          <p><b>Specific column:</b> exact match (except Modes{selectedGraph === 'Transit' ? <> &amp; Stop Name</> : null} which use partial match)</p>
          {selectedGraph === 'Transit' && (
            <p><b>Accent insensitive:</b> <code>geneve</code> matches <code>Genève</code></p>
          )}
        </div>
      </span>
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
