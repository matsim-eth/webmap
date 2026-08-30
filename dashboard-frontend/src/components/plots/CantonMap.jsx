import React, { useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useDashboard } from '../../context/DashboardContext';
import { useData } from '../../context/DataContext';
import { useCantonMap, CANTON_NAME_TO_NUM } from '../../hooks/useCantonMap';
import { useLinePolygonCounts } from '../../hooks/useLinePolygonCounts';
import { useEffectiveLineCantons } from '../../hooks/useEffectiveLineCantons';
import { lineMatchesFilter, stopMatchesFilter } from '../../utils/transitLineFilter';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const CantonMap = ({ sidebarCollapsed, isExpanded = false, activeTab }) => {
  const mapContainer = useRef(null);
  const {
    selectedCanton, setSelectedCanton,
    selectedTransitStop, setSelectedTransitStop,
    setSelectedTransitLine,
    selectedLineMeta, setSelectedLineMeta,
    selectedMunicipality, setSelectedMunicipality,
    selectedLineModes,
    polygonSet,
    datasetId,
    zones,
    studyAreaBbox,
    studyAreaCenter,
    studyAreaZoom,
  } = useDashboard();
  const { getCantonData } = useData();

  // Zone boundary loader for useCantonMap: backend zones.json first (per
  // dataset, authoritative), CDN TLM as last resort is handled inside the hook.
  const getZonesGeojson = useCallback(
    () => getCantonData('zones.json'),
    [getCantonData]
  );

  // Mode-filter visibility flags. Selection state stays put; only rendering
  // is suppressed so unfiltering brings the prior selection right back.
  const hideLineByFilter = !!selectedLineMeta && !lineMatchesFilter(selectedLineMeta?.vehicle, selectedLineModes);
  const hideStopByFilter = !!selectedTransitStop && !stopMatchesFilter(selectedTransitStop, selectedLineModes);

  // Resolve cantons for non-catalog lines (e.g. zero-volume `92-920-j24-1`)
  // so the route-display and polygon-overlay effects target the right
  // per-canton files. Synthesize an augmented selectedLineMeta so downstream
  // hooks/effects don't need to know about the discovery.
  const { cantons: effectiveCantons } = useEffectiveLineCantons(selectedLineMeta);
  const effectiveLineMeta = useMemo(() => {
    if (!selectedLineMeta) return null;
    if ((selectedLineMeta.cantons ?? []).length > 0) return selectedLineMeta;
    if (effectiveCantons.length === 0) return selectedLineMeta;
    return { ...selectedLineMeta, cantons: effectiveCantons };
  }, [selectedLineMeta, effectiveCantons]);

  // Skip count fetching when the selected line is filter-hidden — the overlay
  // would be hidden anyway, and the cached query restores instantly when the
  // filter is removed.
  const lineMetaForCounts = hideLineByFilter ? null : effectiveLineMeta;
  const { data: linePolygonData } = useLinePolygonCounts(lineMetaForCounts, polygonSet);

  // The set of polygon IDs the line touches. Drives both the map overlay
  // and (downstream) the click-to-highlight matching.
  const linePolygonIds = useMemo(() => {
    const rows = linePolygonData?.rows ?? [];
    if (!rows.length) return null;
    return new Set(rows.map((r) => String(r.polygon_id)));
  }, [linePolygonData]);

  // Default-polygon path: fetch the cantons-filtered municipalities.geojson.
  // The custom path uses polygonSet.features in memory — no network request.
  const cantonsForLine = Array.isArray(effectiveLineMeta?.cantons) ? effectiveLineMeta.cantons : [];
  const cantonsKey = [...cantonsForLine].sort().join('|');
  // Enabled off the cantons list (known as soon as the line is picked) rather
  // than off linePolygonIds — so this ~54 MB fetch runs in parallel with the
  // counts/stops/muni-lookup pipeline that resolves linePolygonIds, instead of
  // waiting behind it. linePolygonsFC still returns null until the ids land, so
  // rendering timing is unchanged; only the network fetch is parallelized.
  const muniEnabled =
    polygonSet?.kind !== 'custom'
    && !!effectiveLineMeta?.line_id
    && !hideLineByFilter
    && cantonsForLine.length > 0;
  const { data: muniGeo } = useQuery({
    queryKey: ['municipalities-geojson', datasetId, cantonsKey],
    enabled: muniEnabled,
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const cantonsQs = cantonsForLine.length > 0
        ? `?cantons=${cantonsForLine.map(encodeURIComponent).join(',')}`
        : '';
      return getCantonData(`municipalities.geojson${cantonsQs}`);
    },
  });

  // Resolve the FeatureCollection rendered by useCantonMap. Both paths
  // produce {type, features:[]} where each feature has `properties.name`
  // (the map's label layer reads `['get', 'name']`).
  const linePolygonsFC = useMemo(() => {
    if (!linePolygonIds?.size || !effectiveLineMeta?.line_id || hideLineByFilter) return null;

    if (polygonSet?.kind === 'custom') {
      const features = polygonSet?.features ?? [];
      const nameKey = polygonSet?.nameProperty;
      const filtered = [];
      for (const f of features) {
        const idCandidate = f.id ?? f.properties?.id ?? (nameKey ? f.properties?.[nameKey] : null);
        if (idCandidate == null) continue;
        if (!linePolygonIds.has(String(idCandidate))) continue;
        // Inject `name` so the label layer can read it uniformly without
        // knowing about nameProperty.
        const labelName = nameKey ? f.properties?.[nameKey] : idCandidate;
        filtered.push({
          ...f,
          properties: { ...f.properties, name: labelName ?? String(idCandidate) },
        });
      }
      return filtered.length ? { type: 'FeatureCollection', features: filtered } : null;
    }

    // Default = municipalities. The geojson features carry `name` already.
    if (!muniGeo?.features) return null;
    const kantonNumSet = new Set(
      cantonsForLine.map((c) => CANTON_NAME_TO_NUM[c]).filter((n) => n != null)
    );
    const candidates = kantonNumSet.size > 0
      ? muniGeo.features.filter((f) => kantonNumSet.has(Number(f.properties?.kantonsnum)))
      : muniGeo.features;
    const filtered = candidates.filter((f) =>
      linePolygonIds.has(String(f.properties?.bfs_nummer))
    );
    return filtered.length ? { type: 'FeatureCollection', features: filtered } : null;
  }, [
    polygonSet,
    muniGeo,
    linePolygonIds,
    effectiveLineMeta,
    hideLineByFilter,
    cantonsForLine,
  ]);

  useCantonMap({
    mapContainer,
    sidebarCollapsed,
    isExpanded,
    activeTab,
    selectedCanton,
    setSelectedCanton,
    selectedTransitStop,
    setSelectedTransitStop,
    setSelectedTransitLine,
    selectedLineMeta: effectiveLineMeta,
    setSelectedLineMeta,
    selectedMunicipality,
    setSelectedMunicipality,
    selectedLineModes,
    linePolygonsFC: linePolygonsFC ?? EMPTY_FC,
    getCantonData,
    hideLineByFilter,
    hideStopByFilter,
    zones,
    studyBbox: studyAreaBbox,
    initialCenter: studyAreaCenter,
    initialZoom: studyAreaZoom,
    getZonesGeojson,
    datasetId,
  });

  return (
    <div className="canton-map-container">
      <div ref={mapContainer} className="canton-map" />
    </div>
  );
};

export default CantonMap;
