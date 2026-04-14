import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';

export default function useCantons({
  mapRef,
  mapReady,
  setClickedCanton,
  searchCanton,
  isSidebarOpen,
  isGraphExpanded,
  suppressNextSearchZoom,
  graphExpandedRef,
  isFeatureTableOpen,
  setIsFeatureTableOpen,
  isLeftSidebarOpen
}) {
  
  // avoid changing padding when we select new canton
  const suppressPaddingRef = useRef(false);

  // avoid re-running search-zoom effect on every sidebar toggle —
  // use a ref so fitBounds always reads the latest value without re-triggering
  const isLeftSidebarOpenRef = useRef(isLeftSidebarOpen);
  useEffect(() => { isLeftSidebarOpenRef.current = isLeftSidebarOpen; }, [isLeftSidebarOpen]);

  // 1) padding on sidebar resize
  useEffect(() => {

    if (!mapReady) return;
    if (suppressPaddingRef.current) return;
    const map = mapRef.current;
    if (!map) return;

    let rightPadding = 50;
    const leftPadding = isLeftSidebarOpen ? 185 : 50;

    // Right sidebar is only visible when both open AND a module is active
    if (isSidebarOpen && isGraphExpanded) {
      const mediumGraphs = [
        'Destination', 'PtBoardings'
      ];

      if (isGraphExpanded === 'Volumes' || isGraphExpanded === 'TransitVolumes' || isGraphExpanded === 'Transit' || isGraphExpanded === 'VolumeFlow') {
        rightPadding = isFeatureTableOpen ? 950 : 650;
      } else if (mediumGraphs.includes(isGraphExpanded)) {
        rightPadding = 650;
      } else {
        // Default (Network/Choropleth): 950px when table open, 350px otherwise
        rightPadding = isFeatureTableOpen ? 950 : 350;
      }
    }
    
    map.easeTo({
      padding: { top: 50, bottom: 50, left: leftPadding, right: rightPadding },
      duration: 600,
    });
  }, [mapRef, mapReady, isSidebarOpen, isGraphExpanded, isFeatureTableOpen, isLeftSidebarOpen]);
  
  // 2) zoom to canton on search (with correct padding)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchCanton) return;
    
    // if we suppress next zoom, dont do anything
    if (suppressNextSearchZoom.current) {
      console.log('suppressing search zoom');
      
      // note we reset supressnextSearchZoom in useTransitStops after we apply the opacity filter to stops
      // not corresponding to the currently selected transit line
      return;
    }
    
    setIsFeatureTableOpen(false);
    suppressPaddingRef.current = true
    
    const bbox = bboxCache[searchCanton];
    if (!bbox) return;
    setClickedCanton(searchCanton);
    map.setFilter('selected-canton-border',['==','NAME',searchCanton]);
    
    // Determine right padding based on sidebar and graph
    let rightPadding = 50;
    const leftPadding = isLeftSidebarOpenRef.current ? 185 : 50;

    if (isSidebarOpen && graphExpandedRef.current) {
      const mediumGraphs = [
        'Volumes', 'Transit', 'TransitVolumes', 'Destination', 'PtBoardings', 'VolumeFlow'
      ];

      if (mediumGraphs.includes(graphExpandedRef.current)) {
        rightPadding = 650;
      } else {
        rightPadding = 350;
      }
    }
    
    map.fitBounds(bbox, {
      padding: { top: 50, bottom: 50, left: leftPadding, right: rightPadding },
      maxZoom: 10,
      duration: 1000,
    });
    
    map.once('moveend', () => {                  // re-enable after animation
      suppressPaddingRef.current = false;
    });
    
  }, [mapRef, searchCanton, setClickedCanton, suppressNextSearchZoom]);
}
