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

const VARIABLES = {
  "Departure Time": "departure_time",
  "Euclidean Distance": "euclidean_distance",
  "Network Distance": "network_distance",
};

const ModeShareLinePlot = ({ canton, aggCol = "mode" }) => {
  const [selectedVariable, setSelectedVariable] = useState("departure_time");
  const [plotData, setPlotData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

useEffect(() => {
  const filename = `lineplot_${selectedVariable}_data_${aggCol}.json`;

  loadWithFallback(filename)
    .then((jsonData) => {
      const selectedCanton = canton || "All";
      const cantonData = jsonData[selectedCanton];
      if (cantonData && cantonData.microcensus && cantonData.synthetic) {
        setPlotData(cantonData);
      } else {
        console.error(`No data found for canton: ${selectedCanton}`);
        setPlotData(null);
      }
    })
    .catch((error) => console.error(`Error loading ${selectedVariable} data:`, error));
}, [selectedVariable, canton, aggCol]);

  if (!plotData) return <p>Loading...</p>;

  const getColor = (val) => {
    if (aggCol === "mode") return MODE_COLORS[val] || "#7f7f7f";
    if (aggCol === "purpose") return PURPOSE_COLORS[val] || "#7f7f7f";
    return "#7f7f7f"; // fallback color
  };

  const generateTraces = (data, datasetName, lineStyle) => {
    const uniqueValues = [...new Set(data.map((entry) => entry[aggCol]))];

    return uniqueValues.map((val) => {
      const filtered = data.filter((entry) => entry[aggCol] === val);
      if (filtered.length === 0) return null;

      return {
        type: "scatter",
        mode: "lines+markers",
        x: filtered.map((entry) => entry.variable_midpoint),
        y: filtered.map((entry) => entry.percentage),
        name: `${val} (${datasetName})`,
        line: {
          color: getColor(val),
          dash: lineStyle,
        },
      };
    }).filter(Boolean); // Remove any nulls
  };

  const tickVals = plotData.tick_vals || [];
  const tickLabels = plotData.tick_labels || [];

  const traces = [
    ...generateTraces(plotData.microcensus, "Microcensus", "solid"),
    ...generateTraces(plotData.synthetic, "Synthetic", "dash"),
  ];

  return (
    <div className="overlay-panel">
      <h3>
        {cantonAlias[canton] || "All"} - {aggCol.charAt(0).toUpperCase() + aggCol.slice(1)} Share Line Plot
      </h3>

      <div style={{ display: "flex", gap: "15px", marginBottom: "10px" }}>
        {Object.entries(VARIABLES).map(([label, value]) => (
          <label key={value} style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
            <input
              type="radio"
              value={value}
              checked={selectedVariable === value}
              onChange={() => setSelectedVariable(value)}
              style={{ marginRight: "5px" }}
            />
            {label}
          </label>
        ))}
      </div>

      <Plot
        data={traces}
        layout={{
          title: `${aggCol.charAt(0).toUpperCase() + aggCol.slice(1)} Share vs ${selectedVariable.replace("_", " ")}`,
          xaxis: {
            title: {
              text: selectedVariable.replace("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()),
              font: { size: 14 },
              standoff: 20,
            },
            tickmode: "array",
            tickvals: tickVals,
            ticktext: tickLabels,
            tickangle: 45,
          },
          yaxis: {
            title: { text: `${aggCol.charAt(0).toUpperCase() + aggCol.slice(1)} Share [%]`, font: { size: 14 } },
          },
          legend: { title: { text: `${aggCol.charAt(0).toUpperCase() + aggCol.slice(1)}s` } },
          width: 880,
          height: 450,
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)",
          margin: { l: 60, r: 20, t: 20, b: 80 },
        }}
      />
    </div>
  );
};

export default ModeShareLinePlot;
