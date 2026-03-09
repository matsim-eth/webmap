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

const DISTANCE_CATEGORIES = ["0-1000", "1000-5000", "5000-25000", "25000+"];
const DISTANCE_LABELS = ["0-1 km", "1-5 km", "5-25 km", "25+ km"];
const DATASETS = ["Microcensus", "Synthetic"];

const ByDistanceStacked = ({ sidebarCollapsed, isExpanded = false, type = 'mode' }) => {
  const { selectedCanton, distanceType, selectedMode, selectedPurpose } = useDashboard();
  const [data, setData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  // Select colors and filter based on type
  const colors = type === 'mode' ? MODE_COLORS : PURPOSE_COLORS;
  const selectedFilter = type === 'mode' ? selectedMode : selectedPurpose;
  const filterKey = type === 'mode' ? 'mode' : 'purpose';
  const titlePrefix = type === 'mode' ? 'Mode' : 'Purpose';

  // Trigger resize when sidebar collapses/expands
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 100);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const filename = distanceType === "euclidean" 
      ? `stacked_bar_euclidean_distance_${type}.json`
      : `stacked_bar_network_distance_${type}.json`;
    
    loadWithFallback(filename)
      .then((jsonData) => {
        const cantonKey = selectedCanton || "All";
        if (jsonData[cantonKey]) {
          setData(jsonData[cantonKey]);
        }
      })
      .catch((error) => console.error("Error loading data:", error));
  }, [selectedCanton, distanceType, type]);

  if (!data) return <div className="plot-loading">Loading...</div>;

  const items = [...new Set(data.map((d) => d[filterKey]))];
  const filteredItems = selectedFilter === "all" ? items : items.filter(i => i === selectedFilter);
  
  // Generate traces for subplots (4 columns for distance categories)
  const generateTraces = () => {
    let traces = [];
    
    DISTANCE_CATEGORIES.forEach((category, i) => {
      DATASETS.forEach((dataset) => {
        const datasetData = data.filter(
          (entry) =>
            entry.distance_category === category && 
            entry.dataset === dataset &&
            filteredItems.includes(entry[filterKey])
        );
        
        datasetData.forEach((entry) => {
          const key = entry[filterKey];
          
          traces.push({
            type: "bar",
            x: [dataset],
            y: [entry.percentage],
            name: key,
            text: isExpanded && entry.percentage >= 5 ? [`${entry.percentage.toFixed(1)}%`] : [""],
            textposition: "inside",
            insidetextanchor: "middle",
            hovertemplate: `${key}<br>${dataset}: ${entry.percentage.toFixed(1)}%<extra></extra>`,
            marker: { color: colors[key] || "#999" },
            opacity: 0.85,
            legendgroup: key,
            showlegend: dataset === "Microcensus" && i === 0,
            xaxis: i === 0 ? "x" : `x${i + 1}`,
            yaxis: i === 0 ? "y" : `y${i + 1}`,
            textfont: { size: 9, color: "#fff" },
          });
        });
      });
    });
    
    return traces;
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{titlePrefix} Distribution by Distance Travelled</h4>
      <Plot
        data={generateTraces()}
        layout={{
          grid: { rows: 1, columns: 4, pattern: "independent" },
          barmode: "stack",
          bargap: 0.15,
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          showlegend: true,
          legend: {
            orientation: "v",
            x: 1.02,
            y: 1,
            xanchor: "left",
            yanchor: "top",
            font: { size: 8 },
          },
          margin: { l: 35, r: 10, t: isExpanded ? 35 : 25, b: 40 },
          autosize: true,
          annotations: DISTANCE_CATEGORIES.map((cat, i) => ({
            text: DISTANCE_LABELS[i],
            x: 0.5,
            y: isExpanded ? 1.05 : 1.08,
            xref: i === 0 ? "x domain" : `x${i + 1} domain`,
            yref: i === 0 ? "y domain" : `y${i + 1} domain`,
            showarrow: false,
            font: { size: 10 },
            xanchor: "center",
          })),
          xaxis: { tickfont: { size: 8 }, showgrid: false },
          yaxis: { tickfont: { size: 8 }, range: [0, 105], showgrid: true, title: "" },
          xaxis2: { tickfont: { size: 8 }, showgrid: false },
          yaxis2: { tickfont: { size: 8 }, range: [0, 105], showgrid: true },
          xaxis3: { tickfont: { size: 8 }, showgrid: false },
          yaxis3: { tickfont: { size: 8 }, range: [0, 105], showgrid: true },
          xaxis4: { tickfont: { size: 8 }, showgrid: false },
          yaxis4: { tickfont: { size: 8 }, range: [0, 105], showgrid: true },
        }}
        useResizeHandler={true}
        style={{ width: "100%", height: "100%" }}
        config={{ 
          responsive: true, 
          displayModeBar: isExpanded ? 'hover' : false,
          toImageButtonOptions: { 
            filename: `${type}-by-distance`,
            format: 'png',
            height: 800,
            width: 1200
          } 
        }}
      />
    </div>
  );
};

export default ByDistanceStacked;
