import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDashboard } from '../context/DashboardContext';
import { useData } from '../context/DataContext';
import { useLineCantonCounts } from './useLineCantonCounts';
import { useEffectiveLineCantons } from './useEffectiveLineCantons';
import { parseStopFeatureLines } from '../utils/transitLineFilter';

/**
 * Transit Stops / Transit Lines comparison infrastructure.
 *
 * The transit tabs are synthetic-only (microcensus has no boardings), so a
 * "comparison" here means the two slots point at *different datasets* — the
 * slot subDataset is irrelevant. useTransitDatasets() dedupes the slots by
 * datasetId: one unique dataset → components behave exactly as before
 * (single mode); two → comparison mode.
 *
 * Alignment across datasets (same scenario, different MATSim runs):
 *   - Stops: join by stop_id first; when none of the selected stop's ids
 *     exist in the secondary dataset's stops geojson, fall back to matching
 *     the stop *name*. resolveStopIds() returns null when neither works.
 *   - Lines: join by line_id first, falling back to line_name
 *     (resolveLineId over count rows / resolveLineIdFromStopGeos over
 *     stops geojsons).
 *
 * Fetch pattern (mirrors useComparisonData): the primary dataset keeps the
 * existing relative-path getCantonData queries — identical query keys, so
 * cache is shared with the non-comparison components and the upload/CDN
 * fallback chain is preserved. The secondary dataset is fetched with
 * explicit `/backend/data/{id}/...` URLs via getUrlData. Hook counts are
 * fixed (always two useQuery calls, gated by `enabled`) per React's rules.
 */

/** Unique datasets across the comparison slots, slot order preserved. */
export function useTransitDatasets() {
  const { comparisonSlots } = useDashboard();
  return useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const slot of comparisonSlots) {
      if (!slot || slot.datasetId == null || seen.has(slot.datasetId)) continue;
      seen.add(slot.datasetId);
      out.push({
        datasetId: slot.datasetId,
        name: slot.datasetName,
        color: slot.color,
        isPrimary: out.length === 0,
      });
    }
    return out;
  }, [comparisonSlots]);
}

/** Normalize a raw stop_id property (array / JSON string / csv) to string ids. */
export function normalizeIdList(raw) {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return list.flatMap((s) => {
    if (Array.isArray(s)) return s.map(String);
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      return String(s).split(',').map((id) => id.trim()).filter(Boolean);
    }
  });
}

/** The flatMap(JSON.parse ‖ split(',')) cleanup shared by the stop plots. */
export function cleanStopIds(selectedTransitStop) {
  return normalizeIdList(selectedTransitStop?.stop_ids);
}

/** Look up a line's display name inside a stop's lines[] property. */
export function getLineNameFromStop(selectedTransitStop, lineId) {
  if (!selectedTransitStop || lineId == null) return null;
  let linesArray = selectedTransitStop.lines;
  if (typeof linesArray === 'string') {
    try { linesArray = JSON.parse(linesArray); } catch { return null; }
  }
  if (!Array.isArray(linesArray)) return null;
  const lineObj = linesArray.find((l) => String(l.line_id) === String(lineId));
  return lineObj?.line_name || lineObj?.lineName || lineObj?.name || null;
}

/**
 * Resolve which line_id to filter by inside `rows` (count rows carrying
 * line_id + line_name): the given id when present, else the id of the row
 * whose line_name matches, else the given id (matches nothing).
 */
export function resolveLineId(rows, lineId, lineName) {
  if (lineId == null || !Array.isArray(rows)) return lineId;
  const idStr = String(lineId);
  if (rows.some((r) => String(r.line_id) === idStr)) return lineId;
  if (lineName != null) {
    const byName = rows.find(
      (r) => r.line_name != null && String(r.line_name) === String(lineName)
    );
    if (byName) return byName.line_id;
  }
  return lineId;
}

/** Same id-then-name resolution, but scanning stops geojsons' lines[]. */
export function resolveLineIdFromStopGeos(stopGeos, lineId, lineName) {
  if (lineId == null) return lineId;
  const idStr = String(lineId);
  let nameMatch = null;
  for (const geo of stopGeos) {
    if (!geo?.features) continue;
    for (const f of geo.features) {
      const parsed = parseStopFeatureLines(f.properties?.lines);
      for (const l of parsed) {
        if (String(l.line_id) === idStr) return lineId;
        if (
          nameMatch == null &&
          lineName != null &&
          l.line_name != null &&
          String(l.line_name) === String(lineName)
        ) {
          nameMatch = l.line_id;
        }
      }
    }
  }
  return nameMatch ?? lineId;
}

/**
 * Filter per-canton count rows by stop ids / line id.
 *   - stopIds undefined → no stop filter (no stop selected)
 *   - stopIds null      → stop selected but unmatched in this dataset → []
 */
export function filterCountRows(rows, { stopIds, lineId } = {}) {
  if (!Array.isArray(rows)) return [];
  let out = rows;
  if (stopIds !== undefined) {
    if (stopIds === null) return [];
    out = out.filter((d) => stopIds.includes(String(d.stop_id)));
  }
  if (lineId != null) {
    out = out.filter((d) => String(d.line_id) === String(lineId));
  }
  return out;
}

/** '#rrggbb' → 'rgba(r, g, b, a)'; passthrough for anything else. */
export function hexToRgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Per-dataset per_canton_counts for the selected canton.
 * Returns entries aligned with useTransitDatasets():
 *   [{ dataset, rows, isLoading }]
 */
export function useCantonCountsPerDataset(canton) {
  const datasets = useTransitDatasets();
  const { getCantonData, getUrlData } = useData();
  const ds0 = datasets[0] ?? null;
  const ds1 = datasets[1] ?? null;
  const enabled = !!canton && canton !== 'All';

  // Primary: same query key + relative path as the existing single-dataset
  // components, so the cache entry is shared with them.
  const q0 = useQuery({
    queryKey: ['cantonCounts', ds0?.datasetId, canton],
    enabled: enabled && !!ds0,
    queryFn: () =>
      getCantonData(`matsim/transit/per_canton_counts/${encodeURIComponent(canton)}_counts.json`)
        .catch(() => null),
  });

  const q1 = useQuery({
    queryKey: ['cantonCounts', ds1?.datasetId, canton],
    enabled: enabled && !!ds1,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      getUrlData(`/backend/data/${ds1.datasetId}/matsim/transit/per_canton_counts/${encodeURIComponent(canton)}_counts.json`)
        .catch(() => null),
  });

  return useMemo(() => {
    const out = [];
    if (ds0) out.push({ dataset: ds0, rows: q0.data ?? null, isLoading: q0.isLoading });
    if (ds1) out.push({ dataset: ds1, rows: q1.data ?? null, isLoading: q1.isLoading });
    return out;
  }, [ds0, ds1, q0.data, q0.isLoading, q1.data, q1.isLoading]);
}

const normName = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Stop alignment against the secondary dataset's stops geojson for `canton`.
 *
 * resolveStopIds(dataset, selectedTransitStop) →
 *   - primary dataset (or single mode): the cleaned stop ids as-is
 *   - secondary: cleaned ids when any of them exist in the secondary
 *     geojson; else the ids of the same-named stop; else null (unmatched).
 */
export function useStopAlignment(canton) {
  const datasets = useTransitDatasets();
  const { getUrlData } = useData();
  const ds1 = datasets[1] ?? null;
  const enabled = !!ds1 && !!canton && canton !== 'All';

  const { data: geo } = useQuery({
    queryKey: ['stops-geo-alignment', ds1?.datasetId, canton],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      getUrlData(`/backend/data/${ds1.datasetId}/matsim/transit/stops_by_canton/${canton}_stops.geojson`)
        .catch(() => null),
  });

  const { idSet, nameToIds } = useMemo(() => {
    const ids = new Set();
    const names = new Map();
    if (geo?.features) {
      for (const f of geo.features) {
        const stopIds = normalizeIdList(f.properties?.stop_id);
        for (const id of stopIds) ids.add(id);
        const key = normName(f.properties?.name);
        if (key) names.set(key, (names.get(key) ?? []).concat(stopIds));
      }
    }
    return { idSet: ids, nameToIds: names };
  }, [geo]);

  const resolveStopIds = useCallback(
    (dataset, selectedTransitStop) => {
      const cleaned = cleanStopIds(selectedTransitStop);
      const isSecondary = !!ds1 && dataset?.datasetId === ds1.datasetId && !dataset?.isPrimary;
      if (!isSecondary) return cleaned;
      // Alignment geo not loaded (yet, or failed) → assume ids line up.
      if (!geo) return cleaned;
      if (cleaned.some((id) => idSet.has(id))) return cleaned;
      const byName = nameToIds.get(normName(selectedTransitStop?.name));
      return byName?.length ? byName : null;
    },
    [ds1, geo, idSet, nameToIds]
  );

  return { resolveStopIds };
}

/**
 * Per-dataset per-line count rows across the line's cantons (Transit Lines
 * tab). Primary delegates to useLineCantonCounts (shared cache with the
 * single-dataset consumers); secondary fetches the same cantons from the
 * secondary backend and applies line id→name fallback. The canton list
 * comes from the primary's discovery — same-scenario assumption.
 *
 * Returns [{ dataset, rows, isLoading }] aligned with useTransitDatasets().
 */
export function useLineCantonCountsMulti(selectedLineMeta) {
  const datasets = useTransitDatasets();
  const { getUrlData } = useData();
  const ds0 = datasets[0] ?? null;
  const ds1 = datasets[1] ?? null;

  const lineId = selectedLineMeta?.line_id ?? null;
  const lineName = selectedLineMeta?.line_name ?? null;
  const { cantons, isLoading: cantonsLoading } = useEffectiveLineCantons(selectedLineMeta);
  const cantonsKey = [...cantons].sort().join('|');

  const primary = useLineCantonCounts(selectedLineMeta);

  const secondary = useQuery({
    queryKey: ['line-canton-counts-secondary', ds1?.datasetId, lineId, cantonsKey],
    enabled: !!ds1 && !!lineId && cantons.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const results = await Promise.all(
        cantons.map((c) =>
          getUrlData(`/backend/data/${ds1.datasetId}/matsim/transit/per_canton_counts/${encodeURIComponent(c)}_counts.json`)
            .catch(() => null)
        )
      );
      const all = [];
      for (const result of results) {
        if (!result) continue;
        const list = Array.isArray(result)
          ? result
          : (Array.isArray(result.data) ? result.data : []);
        all.push(...list);
      }
      const effectiveId = resolveLineId(all, lineId, lineName);
      const idStr = String(effectiveId);
      return { rows: all.filter((r) => String(r.line_id) === idStr) };
    },
  });

  return useMemo(() => {
    const out = [];
    if (ds0) {
      out.push({
        dataset: ds0,
        rows: primary.data?.rows ?? null,
        isLoading: primary.isLoading,
      });
    }
    if (ds1) {
      out.push({
        dataset: ds1,
        rows: secondary.data?.rows ?? null,
        isLoading: cantonsLoading || secondary.isLoading,
      });
    }
    return out;
  }, [ds0, ds1, primary.data, primary.isLoading, secondary.data, secondary.isLoading, cantonsLoading]);
}

/**
 * Per-dataset `stop_transfer_data_by_canton.json` (used by the Transfer
 * Matrix and Transfer Destinations plots). Primary uses the relative path
 * (shared DataContext cache with the components' getData); secondary hits
 * `/backend/data/{id}/...`.
 *
 * Returns [{ dataset, data, isLoading }] aligned with useTransitDatasets().
 */
export function useTransferDataPerDataset() {
  const datasets = useTransitDatasets();
  const { getCantonData, getUrlData } = useData();
  const ds0 = datasets[0] ?? null;
  const ds1 = datasets[1] ?? null;

  const q0 = useQuery({
    queryKey: ['transfer-data', ds0?.datasetId],
    enabled: !!ds0,
    staleTime: 5 * 60 * 1000,
    queryFn: () => getCantonData('stop_transfer_data_by_canton.json').catch(() => null),
  });

  const q1 = useQuery({
    queryKey: ['transfer-data', ds1?.datasetId],
    enabled: !!ds1,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      getUrlData(`/backend/data/${ds1.datasetId}/stop_transfer_data_by_canton.json`)
        .catch(() => null),
  });

  return useMemo(() => {
    const out = [];
    if (ds0) out.push({ dataset: ds0, data: q0.data ?? null, isLoading: q0.isLoading });
    if (ds1) out.push({ dataset: ds1, data: q1.data ?? null, isLoading: q1.isLoading });
    return out;
  }, [ds0, ds1, q0.data, q0.isLoading, q1.data, q1.isLoading]);
}

/**
 * Collect the platform stop_ids of the selected stop *as seen by* a given
 * dataset. Primary uses the stop's own ids (singular + list); the secondary
 * dataset resolves through useStopAlignment's resolveStopIds (id-first,
 * name-fallback). Returns [] when nothing lines up (stop absent in that run).
 */
export function candidateStopIdsForDataset(dataset, selectedTransitStop, resolveStopIds) {
  const ids = [];
  const primaryId = selectedTransitStop?.stop_id;
  if (primaryId) ids.push(...(Array.isArray(primaryId) ? primaryId : [primaryId]).map(String));

  if (dataset?.isPrimary) {
    ids.push(...cleanStopIds(selectedTransitStop));
  } else {
    const resolved = resolveStopIds(dataset, selectedTransitStop);
    if (resolved === null) return []; // unmatched in this dataset
    ids.push(...resolved.map(String));
  }
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Given a dataset's transfer file, the active canton and a candidate id list,
 * return the merged per-stop transfer records (all matched platforms). Mirrors
 * the exact-then-partial matching the single-dataset plots used.
 */
export function matchTransferParts(transferData, canton, candidateIds) {
  if (!transferData || !canton) return [];
  const cantonData = {
    ...(transferData[canton] || {}),
    ...(transferData.inter_cantonal || {}),
  };
  if (Object.keys(cantonData).length === 0) return [];

  let matchedKeys = [...new Set(candidateIds.filter((id) => id && cantonData[id]))];
  if (matchedKeys.length === 0) {
    const keys = Object.keys(cantonData);
    matchedKeys = [...new Set(candidateIds.flatMap((stopId) =>
      stopId
        ? keys.filter((key) => key.includes(stopId) || stopId.includes(key.split(':')[0] + ':'))
        : []
    ))];
  }
  return matchedKeys.map((k) => cantonData[k]).filter(Boolean);
}
