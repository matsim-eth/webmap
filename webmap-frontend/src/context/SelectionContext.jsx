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
  const [visualizeNonce, setVisualizeNonce] = useState(0);
  const [hoveredMatrixCell, setHoveredMatrixCell] = useState(null);

  // Triggers the ant-path even when the user re-selects the same link.
  // Without the nonce, setVisualizeLinkId(sameId) is a no-op for useAntPath.
  const triggerVisualize = (id) => {
    setVisualizeLinkId(id == null ? null : String(id));
    setVisualizeNonce((n) => n + 1);
  };

  const [volumeFlowSegment, setVolumeFlowSegment] = useState(null);
  const [volumeFlowSelectedLink, setVolumeFlowSelectedLink] = useState(null);

  const [linkSpeedsSelected, setLinkSpeedsSelected] = useState(null);
  const [linkSpeedsSelectedLink, setLinkSpeedsSelectedLink] = useState(null);

  const [zoneFlowDestCanton, setZoneFlowDestCanton] = useState(null);

  const value = useMemo(() => ({
    clickedCanton, setClickedCanton,
    featureSelection, setFeatureSelection,
    selectedNetworkFeature, setSelectedNetworkFeature,
    selectedTransitLink, setSelectedTransitLink,
    selectedTransitStop, setSelectedTransitStop,
    visualizeLinkId, setVisualizeLinkId,
    visualizeNonce, triggerVisualize,
    hoveredMatrixCell, setHoveredMatrixCell,
    volumeFlowSegment, setVolumeFlowSegment,
    volumeFlowSelectedLink, setVolumeFlowSelectedLink,
    linkSpeedsSelected, setLinkSpeedsSelected,
    linkSpeedsSelectedLink, setLinkSpeedsSelectedLink,
    zoneFlowDestCanton, setZoneFlowDestCanton,
  }), [
    clickedCanton,
    featureSelection, selectedNetworkFeature,
    selectedTransitLink, selectedTransitStop,
    visualizeLinkId, visualizeNonce, hoveredMatrixCell,
    volumeFlowSegment, volumeFlowSelectedLink,
    linkSpeedsSelected, linkSpeedsSelectedLink,
    zoneFlowDestCanton,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};

export const useSelection = () => {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within a SelectionProvider');
  return ctx;
};
