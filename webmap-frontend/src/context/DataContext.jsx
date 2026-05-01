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

  const [destinationData, setDestinationData] = useState(null);
  const [boardingData, setBoardingData] = useState(null);

  const [nodeFlowsData, setNodeFlowsData] = useState(null);

  const [linkSpeedsLinksMap, setLinkSpeedsLinksMap] = useState(null);
  const [linkSpeedsSummary, setLinkSpeedsSummary] = useState(null);

  const [zoneFlowData, setZoneFlowData] = useState(null);
  const [zoneFlowLoading, setZoneFlowLoading] = useState(false);

  const value = useMemo(() => ({
    datasetId, setDatasetId,
    dataURL, setDataURL,
    cantonList, setCantonList,
    featureGeoJSON, setFeatureGeoJSON,
    tableFilterQuery, setTableFilterQuery,
    isFeatureTableOpen, setIsFeatureTableOpen,
    destinationData, setDestinationData,
    boardingData, setBoardingData,
    nodeFlowsData, setNodeFlowsData,
    linkSpeedsLinksMap, setLinkSpeedsLinksMap,
    linkSpeedsSummary, setLinkSpeedsSummary,
    zoneFlowData, setZoneFlowData,
    zoneFlowLoading, setZoneFlowLoading,
  }), [
    datasetId, dataURL, cantonList,
    featureGeoJSON, tableFilterQuery, isFeatureTableOpen,
    destinationData, boardingData,
    nodeFlowsData,
    linkSpeedsLinksMap, linkSpeedsSummary,
    zoneFlowData, zoneFlowLoading,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useData = () => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within a DataProvider');
  return ctx;
};
