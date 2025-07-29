import { useEffect } from 'react';

export default function useAntPath(mapRef, visualizeLinkId, graphExpandedRef) {
  useEffect(() => {
    if (!visualizeLinkId || !mapRef.current) return;
    
    const map = mapRef.current;
    
    const currentModule = graphExpandedRef?.current;
    const sourceId =
    currentModule === "TransitVolumes" ? "transit-volumes-source" : "network-source";
    
    const source = map.getSource(sourceId);
    if (!source || !source._data) return;
    
    // Access full GeoJSON source
    const fullGeoJSON = source._data;
    const feature = fullGeoJSON.features.find(f => f.properties.id === visualizeLinkId);
    
    if (!feature) return;
    
    // convert MultiLineString into a LineString
    // if a line is discontinuous, it forces it to be continuous
    // ie: -----      ------- →  --------------------
    const mergedCoords =
    feature.geometry.type === "LineString"
    ? feature.geometry.coordinates
    : feature.geometry.type === "MultiLineString"
    ? feature.geometry.coordinates.flat()
    : [];
    
    if (mergedCoords.length < 2) return;
    
    // Remove existing layer/source
    if (map.getLayer("ant-line")) map.removeLayer("ant-line");
    if (map.getSource("ant-path")) map.removeSource("ant-path");
    
    // Add new source with a single LineString
    map.addSource("ant-path", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: mergedCoords,
        },
        properties:
        currentModule === "TransitVolumes" // add modes only if in TransitVolumes module so we can filter by mode and hide/show ant path
        ? { modes: feature.properties?.modes ?? [] }
        : {},
      },
    });
    
    map.addLayer({
      id: "ant-line",
      type: "line",
      source: "ant-path",
      layout: {},
      paint: {
        "line-color": "#FF00FF",
        "line-width": 4,
        "line-dasharray": [3, 3], // initial
      },
    });
    
    // Create dash animation sequence
    const dashArraySeq = [
      [0, 0.3, 3, 2.7], [0, 0.6, 3, 2.4], [0, 0.9, 3, 2.1], [0, 1.2, 3, 1.8],
      [0, 1.5, 3, 1.5], [0, 1.8, 3, 1.2], [0, 2.1, 3, 0.9], [0, 2.4, 3, 0.6],
      [0, 2.7, 3, 0.3], [0, 3.0, 3, 0], [0.3, 3, 2.7, 0], [0.6, 3, 2.4, 0],
      [0.9, 3, 2.1, 0], [1.2, 3, 1.8, 0], [1.5, 3, 1.5, 0], [1.8, 3, 1.2, 0],
      [2.1, 3, 0.9, 0], [2.4, 3, 0.6, 0], [2.7, 3, 0.3, 0], [3, 3, 0, 0],
    ];
    
    let dashArrayIdx = 0;
    let lastUpdateTime = 0;
    const frameIntervalMs = 50; // update every 50ms
    
    // Animate line as a "ant path", by constantly changing the dash-array sequence
    // to make it appear to "move"
    function animateLine(timestamp) {
      if (!map.getLayer("ant-line")) return;
      
      if (timestamp - lastUpdateTime >= frameIntervalMs) {
        dashArrayIdx = (dashArrayIdx + 1) % dashArraySeq.length;
        map.setPaintProperty("ant-line", "line-dasharray", dashArraySeq[dashArrayIdx]);
        lastUpdateTime = timestamp;
      }
      
      requestAnimationFrame(animateLine);
    }
    
    requestAnimationFrame(animateLine);
    
    return () => {
      if (map.getLayer("ant-line")) map.removeLayer("ant-line");
      if (map.getSource("ant-path")) map.removeSource("ant-path");
    };
  }, [visualizeLinkId]); // run when visualizeLinkId changes
}