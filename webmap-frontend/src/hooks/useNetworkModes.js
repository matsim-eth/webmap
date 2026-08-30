import { useQuery } from '@tanstack/react-query';
import { handle401 } from '../utils/auth';

// Distinct network-link modes for one zone, straight from `network_links`:
//
//   GET /backend/data/{datasetId}/network_modes.json?canton={zone}
//   → { "Zurich": ["bike", "car", "car_passenger", "rail", "truck", "walk"] }
//
// This exists so the Network/Volumes mode filter can populate immediately.
// The alternative — unioning `properties.modes` across the loaded
// merged_segments FeatureCollection — is equally correct but blocked on a
// tens-of-MB geometry rebuild, which left the dropdown showing only "All" for
// seconds-to-minutes on a detailed network. The backend answers this from a
// narrow columnar scan (no geometry), so it returns in milliseconds.
//
// Returns null on any failure — no data, an { error } payload, or a legacy
// dataset with no `network_links` table — so callers fall back to the
// geometry-derived union rather than showing an empty list.
const fetchNetworkModes = async (datasetId, canton) => {
  const url = `/backend/data/${datasetId}/network_modes.json?canton=${encodeURIComponent(canton)}`;
  let res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) {
    const refreshed = await handle401();
    if (!refreshed) return null; // redirecting to login
    res = await fetch(url, { credentials: 'include' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.error) return null;

  // The backend keys by its own canonical zone name, which can differ in
  // spelling from whatever the caller passed (accents, "St. Gallen"). We
  // asked for exactly one zone, so take that key's value, else the only value.
  const modes = data[canton] ?? Object.values(data)[0];
  return Array.isArray(modes) && modes.length ? modes : null;
};

/**
 * Network-link modes present in `canton` for `datasetId`, or null when the
 * backend can't answer (caller should fall back to the geometry union).
 *
 * Cached per (dataset, zone) — the underlying data is static for a dataset, so
 * switching back to a zone is instant.
 */
export function useNetworkModes(datasetId, canton) {
  const { data } = useQuery({
    queryKey: ['network-modes', datasetId, canton],
    queryFn: () => fetchNetworkModes(datasetId, canton),
    enabled: datasetId != null && !!canton,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  return data ?? null;
}

export default useNetworkModes;
