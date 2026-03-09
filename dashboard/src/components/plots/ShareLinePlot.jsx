import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const MODE_COLORS = {
  car: "#636efa",
  car_passenger: "#ef553b",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
};

const PURPOSE_COLORS = {
  education: "#636efa",
  home: "#ef553b",
  leisure: "#00cc96",
  other: "#ab63fa",
  shop: "#ffa15a",
  work: "#FFEE8C",
};

const ShareLinePlot = ({ 
  sidebarCollapsed, 
  isExpanded = false, 
  type = 'mode',
  plotType = 'departure', // 'departure' or 'distance'
  title,
  xAxisLabel,
  exportFilename
}) => {
  const { selectedCanton, distanceType, selectedMode, selectedPurpose } = useDashboard();
  const [plotData, setPlotData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  // Select colors and filter based on type
  const colors = type === 'mode' ? MODE_COLORS : PURPOSE_COLORS;
  const selectedFilter = type === 'mode' ? selectedMode : selectedPurpose;

  // Trigger resize when sidebar collapses/expands
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 100);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  useEffect(() => {
    let filename;
    if (plotType === 'departure') {
      filename = `lineplot_departure_time_data_${type}.json`;
    } else {
      const selectedVariable = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
      filename = `lineplot_${selectedVariable}_data_${type}.json`;
    }

    loadWithFallback(filename)
      .then((jsonData) => {
        const cantonKey = selectedCanton || "All";
        if (jsonData[cantonKey]) {
          setPlotData(jsonData[cantonKey]);
        }
      })
      .catch((error) => console.error("Error loading data:", error));
  }, [selectedCanton, type, plotType, distanceType]);

  if (!plotData) return <div className="plot-loading">Loading...</div>;

  const generateTraces = (data, lineStyle) => {
    const items = selectedFilter === "all" 
      ? [...new Set(data.map((entry) => entry[type]))]
      : [selectedFilter];

    return items.map((item) => {
      const filtered = data.filter((entry) => entry[type] === item);
      if (filtered.length === 0) return null;

      return {
        type: "scatter",
        mode: "lines+markers",
        x: filtered.map((entry) => entry.variable_midpoint),
        y: filtered.map((entry) => entry.percentage),
        name: item,
        line: { color: colors[item] || "#999", dash: lineStyle },
        marker: { size: 4 },
        legendgroup: item,
        showlegend: false,
      };
    }).filter(Boolean);
  };

  const traces = [
    ...generateTraces(plotData.microcensus, "solid"),
    ...generateTraces(plotData.synthetic, "dash"),
  ];

  // Add dummy traces for color legend (as squares)
  const items = selectedFilter === "all" 
    ? Object.keys(colors)
    : [selectedFilter];
  
  const colorTraces = items.map(item => ({
    type: "scatter",
    mode: "markers",
    x: [null],
    y: [null],
    name: item,
    marker: { color: colors[item], size: 10, symbol: "square" },
    showlegend: true,
    legendgroup: item,
    legendrank: 1,
  }));

  // Add dummy traces for line style legend
  const lineStyleTraces = [
    {
      type: "scatter",
      mode: "lines",
      x: [null],
      y: [null],
      name: "Microcensus",
      line: { color: "#666", dash: "solid", width: 2 },
      showlegend: true,
      legendgroup: "linestyle",
      legendrank: 2,
    },
    {
      type: "scatter",
      mode: "lines",
      x: [null],
      y: [null],
      name: "Synthetic",
      line: { color: "#666", dash: "dash", width: 2 },
      showlegend: true,
      legendgroup: "linestyle",
      legendrank: 2,
    },
  ];

  const allTraces = [...traces, ...colorTraces, ...lineStyleTraces];

  // Handle tick labels
  const tickVals = plotData.tick_vals || [];
  const tickLabels = plotData.tick_labels || [];
  const filteredTickVals = plotType === 'departure' ? tickVals.filter((_, i) => i % 2 === 0) : tickVals;
  const filteredTickLabels = plotType === 'departure' ? tickLabels.filter((_, i) => i % 2 === 0) : tickLabels;

  // Determine title with distance type if needed
  let displayTitle = title;
  if (plotType === 'distance') {
    const distanceLabel = distanceType === "euclidean" ? "Euclidean Distance" : "Network Distance";
    displayTitle = `${type.charAt(0).toUpperCase() + type.slice(1)} Share by ${distanceLabel}`;
  }

  // Determine x-axis label
  let displayXLabel = xAxisLabel;
  if (plotType === 'distance') {
    displayXLabel = distanceType === "euclidean" ? "Euclidean Distance" : "Network Distance";
  }

  const marginBottom = plotType === 'distance' ? 70 : 65;

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{displayTitle}</h4>
      <Plot
        data={allTraces}
        layout={{
          xaxis: {
            title: {
              text: displayXLabel,
              font: { size: 11 },
              standoff: 10
            },
            tickmode: "array",
            tickvals: filteredTickVals,
            ticktext: filteredTickLabels,
            tickangle: 45,
            tickfont: { size: plotType === 'distance' ? 8 : 9 },
          },
          yaxis: { 
            title: {
              text: `${type.charAt(0).toUpperCase() + type.slice(1)} Share [%]`,
              font: { size: 11 },
              standoff: 10
            },
            tickfont: { size: 9 },
          },
          legend: { 
            orientation: "v", 
            x: 1.02, 
            y: 1,
            xanchor: "left",
            yanchor: "top",
            font: { size: 8 },
            tracegroupgap: type === 'mode' ? 5 : 2,
          },
          margin: { l: 50, r: 15, t: 5, b: marginBottom },
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          autosize: true,
        }}
        useResizeHandler={true}
        style={{ width: "100%", height: "100%" }}
        config={{ 
          responsive: true, 
          displayModeBar: isExpanded ? 'hover' : false,
          toImageButtonOptions: { 
            filename: exportFilename,
            format: 'png',
            height: 800,
            width: 1200
          } 
        }}
      />
    </div>
  );
};

export default ShareLinePlot;
