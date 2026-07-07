import { createContext, useContext, useMemo, useState } from 'react';

const DataContext = createContext(null);

/**
 * In-memory data state shared across map hooks and sidebar modules.
 * Holds dataset identity, feature geojson loaded from the network, and
 * the per-module data buckets (node flows, link speeds, zone flows, etc).
 */
export const DataProvider = ({ children }) => {
  const [datasetId, setDatasetId] = useState(1);
  const [dataURL, setDataURL] = useState('https://matsim-eth.github.io/webmap/data/');
  const [cantonList, setCantonList] = useState([]);

  const [featureGeoJSON, setFeatureGeoJSON] = useState(null);
  const [tableFilterQuery, setTableFilterQuery] = useState(null);
  const [isFeatureTableOpen, setIsFeatureTableOpen] = useState(false);

  // Transit-mode polygon containment: Set of stop feature ids currently
  // inside the drawn polygon(s). null = no polygon active. Pushed by
  // TransitModule (via usePointPolygon) so the global search bar can
  // exclude stops outside the polygon.
  const [polygonStopIds, setPolygonStopIds] = useState(null);

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

  const [polygonTripsData, setPolygonTripsData] = useState(null);
  const [polygonTripsLoading, setPolygonTripsLoading] = useState(false);

  const value = useMemo(() => ({
    datasetId, setDatasetId,
    dataURL, setDataURL,
    cantonList, setCantonList,
    featureGeoJSON, setFeatureGeoJSON,
    tableFilterQuery, setTableFilterQuery,
    isFeatureTableOpen, setIsFeatureTableOpen,
    polygonStopIds, setPolygonStopIds,
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
    polygonTripsData, setPolygonTripsData,
    polygonTripsLoading, setPolygonTripsLoading,
  }), [
    datasetId, dataURL, cantonList,
    featureGeoJSON, tableFilterQuery, isFeatureTableOpen, polygonStopIds,
    destinationData, destinationHoveredCanton, destinationSelectedCanton, boardingData,
    nodeFlowsData,
    linkSpeedsLinksMap, linkSpeedsSummary,
    zoneFlowData, zoneFlowLoading,
    transitVolumesByLink,
    polygonTripsData, polygonTripsLoading,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useData = () => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
};
