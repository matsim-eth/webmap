import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import cantonAlias from "../utils/canton_alias.json";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

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
const DATASETS = ["Microcensus", "Synthetic"];

const StackedBarPlots = ({ canton, aggCol = "mode" }) => {
  const [euclideanData, setEuclideanData] = useState(null);
  const [networkData, setNetworkData] = useState(null);
  const loadWithFallback = useLoadWithFallback();
  
  useEffect(() => {
    const cantonKey = canton || "All";
    
    loadWithFallback(`stacked_bar_euclidean_distance_${aggCol}.json`)
    .then((jsonData) => setEuclideanData(jsonData[cantonKey]))
    .catch((error) => console.error("Error loading Euclidean Data:", error));
    
    loadWithFallback(`stacked_bar_network_distance_${aggCol}.json`)
    .then((jsonData) => setNetworkData(jsonData[cantonKey]))
    .catch((error) => console.error("Error loading Network Data:", error));
  }, [canton, aggCol]);
  
  if (!euclideanData || !networkData) return <p>Loading...</p>;
  
  const getColor = (val) => {
    if (aggCol === "mode") return MODE_COLORS[val] || "#999999";
    if (aggCol === "purpose") return PURPOSE_COLORS[val] || "#999999";
    return "#999999";
  };
  
  const generateTraces = (data, datasetName, rowOffset = 1) => {
    let traces = [];
    
    DISTANCE_CATEGORIES.forEach((category, i) => {
      DATASETS.forEach((dataset) => {
        const datasetData = data.filter(
          (entry) =>
            entry.distance_category === category && entry.dataset === dataset
        );
        
        datasetData.forEach((entry) => {
          const axisIndex = i + 1 + (rowOffset - 1) * 4;
          const key = entry[aggCol];
          
          traces.push({
            type: "bar",
            x: [dataset],
            y: [entry.percentage],
            name: key,
            text: [entry.percentage >= 5 ? `${entry.percentage}%` : ""],
            hovertemplate: `Dataset: ${datasetName}<br>${aggCol}: ${key}<br>Percentage: %{y:.1f}%`,
            marker: { color: getColor(key) },
            opacity: 0.7,
            legendgroup: key,
            showlegend: dataset === "Microcensus" && rowOffset === 1 && i === 0,
            xaxis: `x${axisIndex}`,
            yaxis: `y${axisIndex}`,
            textfont: { size: 10 },
          });
        });
      });
      
      // Add category label
      const labelAxis = i + 1 + (rowOffset - 1) * 4;
      traces.push({
        type: "scatter",
        mode: "text",
        x: ["Microcensus"],
        y: [105],
        text: `                         ${category} m`,
        textposition: "top center",
        showlegend: false,
        xaxis: `x${labelAxis}`,
        yaxis: `y${labelAxis}`,
      });
    });
    
    return traces;
  };
  
  const allTraces = [
    ...generateTraces(euclideanData, "Euclidean", 1),
    ...generateTraces(networkData, "Network", 2),
  ];
  
  const annotations = [
    {
      text: "Euclidean Distance",
      x: 0.5,
      y: 1.07,
      xref: "paper",
      yref: "paper",
      showarrow: false,
      font: { size: 17, color: "#000" },
      xanchor: "center",
    },
    {
      text: "Network Distance",
      x: 0.5,
      y: 0.46,
      xref: "paper",
      yref: "paper",
      showarrow: false,
      font: { size: 17, color: "#000" },
      xanchor: "center",
    },
  ];
  
  return (
    <div className="overlay-panel">
    <h3>{cantonAlias[canton] || "All"} - {aggCol.charAt(0).toUpperCase() + aggCol.slice(1)} Share by Distance</h3>
    
    <Plot
    data={allTraces}
    layout={{
      title: "",
      grid: { rows: 2, columns: 4, pattern: "independent" },
      barmode: "stack",
      bargap: 0.15,
      width: 800,
      height: 800,
      paper_bgcolor: "rgba(255,255,255,0)",
      plot_bgcolor: "rgba(255,255,255,0)",
      showlegend: true,
      legend: {
        title: { text: `${aggCol.charAt(0).toUpperCase() + aggCol.slice(1)}s` },
        orientation: "h",
        y: -0.05,
        x: 0.5,
        xanchor: "center",
      },
      margin: { l: 60, r: 20, t: 70, b: 0 },
      annotations,
      ...Object.fromEntries(
        DISTANCE_CATEGORIES.flatMap((_, i) => [
          [`xaxis${i + 1}`, { tickfont: { size: 10 }, showgrid: false }],
          [
            `yaxis${i + 1}`,
            {
              title: i === 0 ? "Euclidean" : "",
              tickfont: { size: 10 },
              range: [0, 110],
              showgrid: true,
            },
          ],
          [`xaxis${i + 5}`, { tickfont: { size: 10 }, showgrid: false }],
          [
            `yaxis${i + 5}`,
            {
              title: i === 0 ? "Network" : "",
              tickfont: { size: 10 },
              range: [0, 110],
              showgrid: true,
            },
          ],
        ])
      ),
    }}
    />
    </div>
  );
};

export default StackedBarPlots;
