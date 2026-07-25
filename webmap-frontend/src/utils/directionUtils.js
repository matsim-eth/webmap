// Route directionality helpers. MATSim/GTFS route ids end in `.H` (Hinweg /
// outbound) or `.R` (Rückweg / return); the UI direction filter values are
// 'total' | 'outbound' | 'return'.

export const getRouteDirection = (routeId) => {
  if (!routeId) return null;
  if (routeId.endsWith('.H')) return 'outbound';
  if (routeId.endsWith('.R')) return 'return';
  return null;
};

// UI direction value → route_id suffix letter ('H'/'R'), null for 'total'.
export const directionLetter = (direction) => {
  if (direction === 'outbound') return 'H';
  if (direction === 'return') return 'R';
  return null;
};

export const filterRoutesByDirection = (routeIds, direction) => {
  if (!routeIds || direction === 'total') return routeIds;
  const suffix = direction === 'outbound' ? '.H' : '.R';
  return routeIds.filter(id => id.endsWith(suffix));
};

// Does a stop's line entry serve `direction`? Prefers the v2 backend's `dirs`
// array (letters from the pt_link_volumes table); falls back to the legacy CDN
// shape where each entry carried a real route_id with an .H/.R suffix. Entries
// with NO direction information (empty dirs, route_id without a suffix) are
// kept — the filter must stay inert when the dataset can't answer.
export const lineServesDirection = (line, direction) => {
  const letter = directionLetter(direction);
  if (!letter) return true;
  if (Array.isArray(line?.dirs)) {
    return line.dirs.length === 0 ? true : line.dirs.includes(letter);
  }
  const rid = line?.route_id;
  if (typeof rid === 'string' && /\.(H|R)$/.test(rid)) {
    return rid.endsWith('.' + letter);
  }
  return true;
};
