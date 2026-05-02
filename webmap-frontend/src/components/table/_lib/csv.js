/**
 * CSV export helpers for the FeatureTable / module sidebars.
 *
 * `buildCsv` and `exportCsvFromInstance` rely on the same `columnDefs` shape
 * the table uses on screen — `{ key, title, render? }` — so the exported
 * file mirrors the visible column order. The `modes` column is special-cased
 * to apply its render function (joins the comma-separated mode list with a
 * space), matching what the user sees in the table cell.
 */

/**
 * RFC 4180-ish escape: wrap in double quotes when the value contains a
 * comma, double quote, or newline, and double-up internal quotes. Used so
 * the `modes` column ("car,truck,bike") survives as a single CSV cell.
 */
export const csvEscape = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/**
 * Build the CSV string from a column-def array and a list of row objects.
 * Returns the joined string (no trailing newline) — caller wraps it in a Blob.
 */
export const buildCsv = (columnDefs, dataArr) => {
  const header = columnDefs.map((c) => csvEscape(c.title)).join(",");
  const lines = dataArr.map((row) =>
    columnDefs
      .map((c) => {
        let val;
        if (c.key === "modes") {
          val = c.render ? c.render(row.modes) : row.modes;
        } else {
          val = row[c.key];
        }
        return csvEscape(val);
      })
      .join(",")
  );
  return [header, ...lines].join("\r\n");
};

/**
 * Pull the currently visible (search-applied) rows from a DataTables
 * instance, build the CSV, and trigger the browser download. Returns
 * `false` (without downloading) when there's no instance or no visible rows
 * — the FeatureTable ref's `exportCsv()` propagates this so the toolbar
 * button can warn instead of silently producing an empty file.
 */
export const exportCsvFromInstance = (dtInstance, columnDefs, filename) => {
  if (!dtInstance) return false;
  const dataArr = dtInstance.rows({ search: "applied" }).data().toArray();
  if (!dataArr.length) return false;
  const csv = buildCsv(columnDefs, dataArr);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, filename);
  return true;
};
