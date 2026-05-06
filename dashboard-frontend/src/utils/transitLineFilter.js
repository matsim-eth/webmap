// Helpers for the Transit Lines tab.
//
//   - Mode-filter predicates (isModeFilterActive, lineMatchesFilter,
//     stopMatchesFilter)
//   - Shape unwrappers for the various JSON-string-or-array fields on stop
//     features (parseMaybeJSON, toLineList, parseStopFeatureLines)
//   - Stop-line transforms (dedupeLinesByLineId, extractLineIds)
//   - Selected-line meta builder (buildSelectedLineMeta) shared by every
//     callsite so the shape stays consistent.

const parseMaybeJSON = (v, fallback = []) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

// boarding_data_by_line.json arrives as one of:
//   - dict keyed by `${line_id}_${line_name}` (raw GitHub-CDN shape)
//   - { data: [...] } (BoardingDataProvider wrapper)
//   - plain array
export const toLineList = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  if (typeof raw === 'object') return Object.values(raw);
  return [];
};

// Stop feature `lines` is an array of {line_id, route_id, mode, line_name},
// possibly serialized as a JSON string. Always returns a plain array.
export const parseStopFeatureLines = (linesProp) => parseMaybeJSON(linesProp, []);

export const isModeFilterActive = (selectedLineModes) =>
  Array.isArray(selectedLineModes)
  && selectedLineModes.length > 0
  && !selectedLineModes.includes('all');

export const lineMatchesFilter = (vehicle, selectedLineModes) => {
  if (!isModeFilterActive(selectedLineModes)) return true;
  return selectedLineModes.includes(String(vehicle));
};

export const stopMatchesFilter = (stop, selectedLineModes) => {
  if (!isModeFilterActive(selectedLineModes)) return true;
  if (!stop) return false;
  let modes = parseMaybeJSON(stop.modes_list, null);
  if (!Array.isArray(modes) || modes.length === 0) {
    modes = parseStopFeatureLines(stop.lines).map((l) => l?.mode).filter(Boolean);
  }
  return modes.some((m) => selectedLineModes.includes(String(m)));
};

// Collapse a stop's `lines` array (one entry per route_id) to one entry per
// line_id while preserving the route_ids list. Used by LinesAtStop.
export const dedupeLinesByLineId = (rawLines) => {
  const arr = parseStopFeatureLines(rawLines);
  if (!arr.length) return [];

  const byId = new Map();
  for (const l of arr) {
    const id = String(l.line_id ?? '');
    if (!id) continue;
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        line_id: id,
        line_name: l.line_name || l.lineName || l.name || id,
        mode: l.mode || 'unknown',
        route_ids: [],
      };
      byId.set(id, entry);
    }
    if (l.route_id) {
      const rid = String(l.route_id);
      if (!entry.route_ids.includes(rid)) entry.route_ids.push(rid);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.line_name.localeCompare(b.line_name, undefined, { numeric: true })
  );
};

// Compact list of unique line_ids from a stop's `lines` array — used by
// useCantonMap to inject `line_ids` into stop features for Mapbox filters.
export const extractLineIds = (rawLines) => {
  const arr = parseStopFeatureLines(rawLines);
  if (!arr.length) return [];
  return [...new Set(arr.map((l) => l?.line_id).filter(Boolean))];
};

// Three callsites build the same selectedLineMeta shape (search bar,
// LinesAtStop click, LinesAtStop auto-select). Centralized so adding a
// field updates all paths together.
//
//   - `line` may be from boarding_data_by_line.json (has `vehicle`,
//     `cantons`, `route_id`) OR from a stop's `lines` array (has `mode`
//     but lacks `cantons`/`route_id`).
//   - `catalogEntry` is the boarding_data_by_line entry for the line, used
//     to fill in cantons/route_id when `line` came from a stop.
export const buildSelectedLineMeta = (line, catalogEntry) => ({
  line_id: line.line_id,
  line_name: line.line_name,
  vehicle: line.vehicle ?? line.mode ?? catalogEntry?.vehicle,
  cantons: Array.isArray(line.cantons)
    ? line.cantons
    : (Array.isArray(catalogEntry?.cantons) ? catalogEntry.cantons : []),
  route_id: Array.isArray(line.route_id)
    ? line.route_id
    : (Array.isArray(catalogEntry?.route_id) ? catalogEntry.route_id : []),
});
