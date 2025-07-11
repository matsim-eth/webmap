import { useEffect, useState } from 'react';

export default function useChoropleth({
  mapRef,
  loadWithFallback,
  selectedMode,
  isGraphExpanded,
  selectedDataset,
  aggCol,
}) {
  
  const [modeShareData, setModeShareData] = useState(null);
  const [maxSharePerMode, setMaxSharePerMode] = useState(null);
  
  useEffect(() => {
    const path = `${aggCol}_share.json`;
    
    loadWithFallback(path)
    .then((data) => {
      setModeShareData(data);
      setMaxSharePerMode(data[`max_share_per_${aggCol}`]);
    })
    .catch((error) => {
      console.error("Error loading mode share data:", error);
    });
  }, [aggCol]);
  
  // Set colours for choropleth by mode (matches with plots)
  const COLOR_MAPS = {
    mode: {
      car: "#636efa",
      car_passenger: "#ef553b",
      pt: "#00cc96",
      bike: "#ab63fa",
      walk: "#ffa15a",
    },
    purpose: {
      education: "#636efa",
      home: "#ef553b",
      leisure: "#00cc96",
      other: "#ab63fa",
      shop: "#ffa15a",
      work: "#FFEE8C",
    },
  };
  
  // Set choropleth colours for cantons
  useEffect(() => {
    
    const map = mapRef.current;
    if (!map.getLayer("canton-fill")) return;
    
    if (selectedMode === "None" || isGraphExpanded !== "Choropleth"){
      map.setPaintProperty("canton-fill", "fill-opacity", 0.15);
      map.setPaintProperty("canton-fill", "fill-color", "#A07CC5");
      return;
    }
    
    // Dynamic key based on aggCol
    const key = aggCol || "mode"; // fallback for safety
    let colorStops = {};
    
    if (selectedDataset === "Difference") {
      const micro = modeShareData["Microcensus"].filter(entry => entry[key] === selectedMode);
      const synthetic = modeShareData["Synthetic"].filter(entry => entry[key] === selectedMode);
      
      const microMap = Object.fromEntries(micro.map(e => [e.canton_name, e.share]));
      const syntheticMap = Object.fromEntries(synthetic.map(e => [e.canton_name, e.share]));
      
      colorStops = Object.keys(microMap).reduce((acc, canton) => {
        const diff = Math.abs((syntheticMap[canton] || 0) - (microMap[canton] || 0));
        const clampedDiff = Math.min(diff, 0.1);
        const normalized = clampedDiff / 0.1;
        acc[canton] = `rgb(${interpolateColor("#FFFFFF", "#ff0000", normalized)})`;
        return acc;
      }, {});
    } else {
      const maxShare = maxSharePerMode?.[selectedMode] || 1;
      colorStops = modeShareData[selectedDataset]
      .filter(entry => entry[key] === selectedMode)
      .reduce((acc, entry) => {
        const normalizedShare = entry.share / maxShare;
        const colorMap = (COLOR_MAPS?.[aggCol] || {});
        acc[entry.canton_name] = `rgb(${interpolateColor("#FFFFFF", colorMap[selectedMode] || "#888", normalizedShare)})`;
        return acc;
      }, {});
    }
    
    map.setPaintProperty("canton-fill", "fill-color", [
      "case",
      ...Object.entries(colorStops).flatMap(([canton, color]) => [["==", ["get", "NAME"], canton], color]),
      "#FFFFFF"
    ]);
    
    map.setPaintProperty("canton-fill", "fill-opacity", 1.0);
  }, [modeShareData, selectedMode, selectedDataset, maxSharePerMode, aggCol, isGraphExpanded]);

  
  // Function to interpolate between two colors (White → Mode Color)
  const interpolateColor = (color1, color2, factor) => {
    const rgb1 = hexToRgb(color1);
    const rgb2 = hexToRgb(color2);
    
    return rgb1.map((c, i) => Math.round(c + (rgb2[i] - c) * factor)).join(", ");
  };
  
  // Convert HEX to RGB array (since we defined colours in HEX)
  const hexToRgb = (hex) => {
    const bigint = parseInt(hex.slice(1), 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
  };
}
