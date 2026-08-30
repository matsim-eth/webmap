import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { handle401 } from '../utils/auth';
import { SWISS_STUDY_AREA } from '../utils/swissDefaults';

// Fetches the dataset's study_area.json (schema below). Any failure — HTTP
// error, network error, or an { error } payload — resolves to the Swiss
// defaults object, so Swiss datasets (and any dataset served by a backend that
// doesn't yet expose the endpoint) behave exactly as before.
//
//   GET /backend/data/{datasetId}/study_area.json
//   { schema_version, name, crs, primary_zone_type, zone_label,
//     zone_label_plural, zone_types, bbox, center, zoom,
//     zones: [{ id, name, display_name, bbox }] }
const fetchStudyArea = async (datasetId) => {
  const url = `/backend/data/${datasetId}/study_area.json`;
  try {
    let res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) {
      const refreshed = await handle401();
      if (!refreshed) return { studyArea: SWISS_STUDY_AREA, isFallback: true };
      res = await fetch(url, { credentials: 'include' });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // A response shaped { error: ... } means "not available → fall back".
    if (!data || data.error || !Array.isArray(data.zones)) {
      return { studyArea: SWISS_STUDY_AREA, isFallback: true };
    }
    return { studyArea: data, isFallback: false };
  } catch {
    return { studyArea: SWISS_STUDY_AREA, isFallback: true };
  }
};

/**
 * Study-area bootstrap. Re-fetches whenever `datasetId` changes (queryKey),
 * so switching datasets picks up the new area's zones / labels / extent.
 *
 * Returns:
 *   studyArea       — the raw study_area object (backend shape or Swiss default)
 *   zoneLabel       — singular primary-zone label ("Canton")
 *   zoneLabelPlural — plural primary-zone label ("Cantons")
 *   zones           — [{ id, name, displayName, bbox }] (normalized)
 *   zoneByName      — Map(name -> normalized zone), for O(1) label/bbox lookup
 *   bbox/center/zoom — map extent
 *   isFallback      — true when the Swiss defaults are in use
 */
export function useStudyArea(datasetId) {
  const { data } = useQuery({
    queryKey: ['study-area', datasetId],
    queryFn: () => fetchStudyArea(datasetId),
    enabled: datasetId != null,
    staleTime: 60 * 60 * 1000,
  });

  // While the query is in flight (data === undefined) fall back to Swiss so the
  // shape is always defined and the initial map view matches the old behaviour.
  const resolved = data?.studyArea ?? SWISS_STUDY_AREA;
  const isFallback = data ? data.isFallback : true;

  return useMemo(() => {
    const sa = resolved;
    const zones = (sa.zones || []).map((z) => ({
      id: z.id ?? null,
      name: z.name,
      displayName: z.display_name ?? z.displayName ?? z.name,
      bbox: z.bbox ?? null,
      center: z.center ?? null,
    }));
    const zoneByName = new Map(zones.map((z) => [z.name, z]));
    return {
      studyArea: sa,
      zoneLabel: sa.zone_label || 'Canton',
      zoneLabelPlural: sa.zone_label_plural || 'Cantons',
      zones,
      zoneByName,
      bbox: sa.bbox || SWISS_STUDY_AREA.bbox,
      center: sa.center || SWISS_STUDY_AREA.center,
      zoom: sa.zoom ?? SWISS_STUDY_AREA.zoom,
      isFallback,
    };
  }, [resolved, isFallback]);
}
