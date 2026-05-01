/**
 * Shared table-row helpers used by the module sidebars
 * (Network/Volumes/LinkSpeeds/TransitVolumes). Each of those modules used to
 * inline its own copy of these utilities; the shapes were identical, only the
 * column sets differed.
 */

/**
 * Row → map payload consumed by useFeatureSelectionFocus / onFocusNetworkFeature.
 * Modules build rows with a stable `rowKey` plus the source `feature` and
 * `coords`; this packages those into the shape the focus hook expects.
 */
export const buildSelectionPayload = (row) => {
  if (!row) return null;
  return { id: row.rowKey, feature: row.feature, coords: row.coords };
};

// DataTables search ignores commas/whitespace inside formatted numbers
// ("1,234" matches "1234"). Strip both sides so JS-side filtering agrees
// byte-for-byte with what DataTables shows.
const norm = (s) => String(s).toLowerCase().replace(/[,\s]/g, '');

/**
 * Build a `rowMatchesQuery(row, query)` predicate that mirrors DataTables'
 * search semantics so the map filter shows exactly the same rows the table is
 * showing: substring on the rendered cell value (or the pipe-joined
 * `searchString` for the "All columns" case).
 *
 * Numeric columns additionally support `>`, `<`, `>=`, `<=` comparison
 * operators as a special case; pass the column names that should opt in via
 * `numericCols` (Set of column keys). `formatCell(column, value)` should
 * return the same string DataTables renders for that cell, so the substring
 * comparison stays consistent.
 */
export const makeRowMatchesQuery = ({ numericCols, formatCell }) => (row, query) => {
  if (!query || !query.value) return true;
  const { column, value } = query;
  const raw = String(value).trim();
  if (!raw) return true;

  if (column && numericCols && numericCols.has(column)) {
    const cmp = raw.match(/^(>=?|<=?)\s*([0-9.,]+)$/);
    if (cmp) {
      const op = cmp[1];
      const n = parseFloat(cmp[2].replace(/,/g, ''));
      const v = Number(row[column]);
      if (!Number.isFinite(v) || !Number.isFinite(n)) return false;
      if (op === '>') return v > n;
      if (op === '<') return v < n;
      if (op === '>=') return v >= n;
      if (op === '<=') return v <= n;
    }
  }

  const hasSemi = raw.includes(';');
  const values = raw.split(hasSemi ? ';' : ',').map(v => v.trim()).filter(Boolean);
  if (!values.length) return true;

  const matchOne = (val) => {
    const needle = norm(val);
    const haystack = column
      ? norm(formatCell ? formatCell(column, row[column]) : row[column] ?? '')
      : norm(row.searchString || '');
    return haystack.includes(needle);
  };

  return hasSemi ? values.every(matchOne) : values.some(matchOne);
};
