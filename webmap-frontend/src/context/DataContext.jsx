import { createContext, useContext, useMemo, useState } from 'react';
import { useStudyArea } from '../hooks/useStudyArea';
import { useDefaultDataset } from '../hooks/useDefaultDataset';

const DataContext = createContext(null);

/**
 * In-memory data state shared across map hooks and sidebar modules.
 * Holds dataset identity, feature geojson loaded from the network, and
 * the per-module data buckets (node flows, link speeds, zone flows, etc).
 */
export const DataProvider = ({ children }) => {
  // Starts null and resolves to the user's first available active dataset (see
  // useDefaultDataset) rather than hardcoding an id — so nothing fetches against
  // a dataset the user may not own before they've picked one.
  const [datasetId, setDatasetId] = useState(null);
  useDefaultDataset(datasetId, setDatasetId);
  const [cantonList, setCantonList] = useState([]);

  // Per-dataset study area (zone labels, zone list, map extent). Re-fetches on
  // datasetId change; falls back to Swiss defaults when the backend can't serve
  // it. Named `studyArea*` here to avoid colliding with existing fields.
  const {
    studyArea, zoneLabel, zoneLabelPlural, zones, zoneByName,
    isFallback: studyAreaIsFallback,
  } = useStudyArea(datasetId);

  const [featureGeoJSON, setFeatureGeoJSON] = useState(null);
  const [tableFilterQuery, setTableFilterQuery] = useState(null);
  const [isFeatureTableOpen, setIsFeatureTableOpen] = useState(false);

  // Transit-mode polygon containment: Set of stop feature ids currently
  // inside the drawn polygon(s). null = no polygon active. Pushed by
  // TransitModule (via usePointPolygon) so the global search bar can
  // exclude stops outside the polygon.
  const [polygonStopIds, setPolygonStopIds] = useState(null);

  // Volumes-mode polygon containment: array of network feature ids (indices
  // into featureGeoJSON.features, = the source's generateId ids) currently
  // intersecting the drawn polygon(s). null = no polygon active. Pushed by
  // VolumesModule (via useLinePolygon) so useFeatureSelectionFocus can hide
  // links outside the polygon on the base AND split (double-link) layers.
  const [polygonLinkIds, setPolygonLinkIds] = useState(null);

  const [destinationData, setDestinationData] = useState(null);
  const [destinationHoveredCanton, setDestinationHoveredCanton] = useState(null);
  const [destinationSelectedCanton, setDestinationSelectedCanton] = useState(null);
  const [boardingData, setBoardingData] = useState(null);

  const [nodeFlowsData, setNodeFlowsData] = useState(null);

  const [linkSpeedsLinksMap, setLinkSpeedsLinksMap] = useState(null);
  const [linkSpeedsSummary, setLinkSpeedsSummary] = useState(null);

  const [zoneFlowData, setZoneFlowData] = useState(null);
  const [zoneFlowLoading, setZoneFlowLoading] = useState(false);

  // TransitVolumes: per-link volume lookup ({ link_id: { lines, linkTotal,
  // modes_list } }) published by useTransitVolumesLayer. The merged segment
  // features only carry segment-level line merges, so narrowing the sidebar
  // attributes table to one link needs this per-link breakdown — kept out of
  // the geojson sources because it would roughly double them (Zurich's volume
  // file is ~24 MB, and the split overlay spreads feature props twice).
  const [transitVolumesByLink, setTransitVolumesByLink] = useState(null);
  // True while Transit Volumes has drawn its links (picked by mode from the
  // shared network geometry) but the per-line volume payload is still loading.
  // The module disables the controls that need it — time window, line/direction
  // filters — instead of leaving them silently inert.
  const [transitVolumesDetailPending, setTransitVolumesDetailPending] = useState(false);

  const [polygonTripsData, setPolygonTripsData] = useState(null);
  const [polygonTripsLoading, setPolygonTripsLoading] = useState(false);

  const value = useMemo(() => ({
    datasetId, setDatasetId,
    cantonList, setCantonList,
    studyArea, zoneLabel, zoneLabelPlural, zones, zoneByName,
    studyAreaIsFallback,
    featureGeoJSON, setFeatureGeoJSON,
    tableFilterQuery, setTableFilterQuery,
    isFeatureTableOpen, setIsFeatureTableOpen,
    polygonStopIds, setPolygonStopIds,
    polygonLinkIds, setPolygonLinkIds,
    destinationData, setDestinationData,
    destinationHoveredCanton, setDestinationHoveredCanton,
    destinationSelectedCanton, setDestinationSelectedCanton,
    boardingData, setBoardingData,
    nodeFlowsData, setNodeFlowsData,
    linkSpeedsLinksMap, setLinkSpeedsLinksMap,
    linkSpeedsSummary, setLinkSpeedsSummary,
    zoneFlowData, setZoneFlowData,
    zoneFlowLoading, setZoneFlowLoading,
    transitVolumesByLink, setTransitVolumesByLink,
    transitVolumesDetailPending, setTransitVolumesDetailPending,
    polygonTripsData, setPolygonTripsData,
    polygonTripsLoading, setPolygonTripsLoading,
  }), [
    datasetId, cantonList,
    studyArea, zoneLabel, zoneLabelPlural, zones, zoneByName, studyAreaIsFallback,
    featureGeoJSON, tableFilterQuery, isFeatureTableOpen, polygonStopIds, polygonLinkIds,
    destinationData, destinationHoveredCanton, destinationSelectedCanton, boardingData,
    nodeFlowsData,
    linkSpeedsLinksMap, linkSpeedsSummary,
    zoneFlowData, zoneFlowLoading,
    transitVolumesByLink, transitVolumesDetailPending,
    polygonTripsData, polygonTripsLoading,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useData = () => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
};
