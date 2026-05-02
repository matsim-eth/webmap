/**
 * Per-module column definitions for the FeatureTable.
 *
 * Two parallel shapes are exposed because the table wants both:
 *   - `getColumnDefs(selectedGraph)` → simple `{ key, title, render? }`
 *     used by the CSV exporter and the toolbar's "Search in:" dropdown.
 *   - `getDtColumns(selectedGraph)` → DataTables column config
 *     (`{ data, title, render?, visible?, searchable? }`) including the
 *     hidden `searchString` column that backs the Transit / LinkSpeeds
 *     "All columns" search.
 *
 * Keep the two in sync — every visible `key` in `columnDefs` must have a
 * matching `data` in `dtColumns`, in the same order, or the CSV header
 * will drift away from the on-screen columns.
 */

const renderModes = (v) => (v ? String(v).replace(/,/g, ", ") : "-");
const renderInteger = (data) => Number(data || 0).toLocaleString();
const renderFixed1 = (data) => (data == null ? '-' : Number(data).toFixed(1));
const renderFixed3 = (data) => (data == null ? '-' : Number(data).toFixed(3));

export const getColumnDefs = (selectedGraph) => {
  if (selectedGraph === 'VolumeFlow') {
    return [
      { key: "directionId", title: "Link ID" },
      { key: "flow", title: "Flow (trips)" },
    ];
  }

  if (selectedGraph === 'Transit') {
    return [
      { key: "stopName", title: "Stop Name" },
      { key: "modes", title: "Modes" },
      { key: "lineCount", title: "# Lines" },
      { key: "boardings", title: "Boardings" },
      { key: "alightings", title: "Alightings" },
    ];
  }

  if (selectedGraph === 'LinkSpeeds') {
    return [
      { key: "linkId", title: "Link ID" },
      { key: "avgSpeed", title: "Avg Speed [km/h]" },
      { key: "freespeed", title: "Freespeed [km/h]" },
      { key: "congestionIndex", title: "Congestion Index" },
      { key: "dailyVolume", title: "Daily Volume" },
      { key: "modes", title: "Modes", render: renderModes },
    ];
  }

  // Default: Network / Volumes / TransitVolumes
  const cols = [
    { key: "directionId", title: "Link ID" },
    { key: "length", title: "Length [m]" },
    { key: "freeSpeed", title: "Speed [km/h]" },
    { key: "capacity", title: "Capacity" },
    { key: "totalVol", title: "Total Daily Volume" },
  ];
  if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
    cols.push({ key: "filteredVolume", title: "Filtered Volume" });
  }
  cols.push({ key: "modes", title: "Modes", render: renderModes });
  return cols;
};

export const getDtColumns = (selectedGraph) => {
  if (selectedGraph === 'VolumeFlow') {
    return [
      { data: "directionId", title: "Link ID" },
      { data: "flow", title: "Flow (trips)", render: renderInteger },
    ];
  }

  if (selectedGraph === 'Transit') {
    return [
      { data: "stopName", title: "Stop Name" },
      { data: "modes", title: "Modes" },
      { data: "lineCount", title: "# Lines" },
      { data: "boardings", title: "Boardings", render: renderInteger },
      { data: "alightings", title: "Alightings", render: renderInteger },
      // Hidden column powers the "All columns" search via row.searchString
      { data: "searchString", title: "", visible: false, searchable: true },
    ];
  }

  if (selectedGraph === 'LinkSpeeds') {
    return [
      { data: "linkId", title: "Link ID" },
      { data: "avgSpeed", title: "Avg Speed [km/h]", render: renderFixed1 },
      { data: "freespeed", title: "Freespeed [km/h]", render: renderFixed1 },
      { data: "congestionIndex", title: "Congestion Index", render: renderFixed3 },
      { data: "dailyVolume", title: "Daily Volume", render: renderInteger },
      { data: "modes", title: "Modes", render: renderModes },
      { data: "searchString", title: "", visible: false, searchable: true },
    ];
  }

  // Default: Network / Volumes / TransitVolumes
  const cols = [
    { data: "directionId", title: "Link ID" },
    { data: "length", title: "Length [m]" },
    { data: "freeSpeed", title: "Speed [km/h]" },
    { data: "capacity", title: "Capacity" },
    { data: "totalVol", title: "Total Daily Volume" },
  ];
  if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
    cols.push({ data: "filteredVolume", title: "Filtered Volume" });
  }
  cols.push({ data: "modes", title: "Modes", render: renderModes });
  return cols;
};

/**
 * Column `data` keys whose values are numeric and should accept comparison
 * operators (`>`, `<`, `>=`, `<=`) in the toolbar search box. Single union
 * across all module variants — checked against the *currently selected*
 * column, so a mismatched module/column combo is benign.
 */
export const NUMERIC_SEARCH_COLS = new Set([
  // Network / Volumes
  "capacity", "length", "freeSpeed", "totalVol", "filteredVolume",
  // Transit stops
  "lineCount", "boardings", "alightings",
  // Link Speeds
  "avgSpeed", "freespeed", "congestionIndex", "dailyVolume",
]);
