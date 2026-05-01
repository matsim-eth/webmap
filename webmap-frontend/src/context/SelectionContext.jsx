import { createContext, useContext, useMemo, useState } from 'react';

const SelectionContext = createContext(null);

/**
 * "What is currently selected on the map" — clicked canton, highlighted
 * features, target links/segments per module. Drives the shared
 * network-highlight layer and most sidebar attribute panels.
 */
export const SelectionProvider = ({ children }) => {
  const [clickedCanton, setClickedCanton] = useState(null);

  const [featureSelection, setFeatureSelection] = useState(null);
  const [selectedNetworkFeature, setSelectedNetworkFeature] = useState(null);

  const [selectedTransitLink, setSelectedTransitLink] = useState(null);
  const [selectedTransitStop, setSelectedTransitStop] = useState(null);

  const [visualizeLinkId, setVisualizeLinkId] = useState(null);
  const [hoveredMatrixCell, setHoveredMatrixCell] = useState(null);

  const [volumeFlowSegment, setVolumeFlowSegment] = useState(null);
  const [volumeFlowSelectedLink, setVolumeFlowSelectedLink] = useState(null);

  const [linkSpeedsSelected, setLinkSpeedsSelected] = useState(null);

  const [zoneFlowDestCanton, setZoneFlowDestCanton] = useState(null);

  const value = useMemo(() => ({
    clickedCanton, setClickedCanton,
    featureSelection, setFeatureSelection,
    selectedNetworkFeature, setSelectedNetworkFeature,
    selectedTransitLink, setSelectedTransitLink,
    selectedTransitStop, setSelectedTransitStop,
    visualizeLinkId, setVisualizeLinkId,
    hoveredMatrixCell, setHoveredMatrixCell,
    volumeFlowSegment, setVolumeFlowSegment,
    volumeFlowSelectedLink, setVolumeFlowSelectedLink,
    linkSpeedsSelected, setLinkSpeedsSelected,
    zoneFlowDestCanton, setZoneFlowDestCanton,
  }), [
    clickedCanton,
    featureSelection, selectedNetworkFeature,
    selectedTransitLink, selectedTransitStop,
    visualizeLinkId, hoveredMatrixCell,
    volumeFlowSegment, volumeFlowSelectedLink,
    linkSpeedsSelected,
    zoneFlowDestCanton,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};

export const useSelection = () => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within a SelectionProvider');
  return ctx;
};
