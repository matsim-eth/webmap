import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import cantonAlias from "../utils/canton_alias.json";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

const DATASET_COLORS = {
  Microcensus: "#4A90E2",
  Synthetic: "#E07A5F",
};

const AverageDist = ({ canton, aggCol }) => {
  const [data, setData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

 useEffect(() => {
    const aggregation = aggCol || "mode";
    const selectedCanton = canton || "All";
    const path = `avg_dist_data_${aggregation}.json`;

    loadWithFallback(path)
      .then((jsonData) => {
        if (jsonData[selectedCanton]) {
          setData(jsonData[selectedCanton]);
        } else {
          console.error(`No data found for canton: ${selectedCanton} in ${path}`);
        }
      })
      .catch((error) => console.error("Error loading JSON:", error));
  }, [canton, aggCol]);

  if (!data) return <p>Loading...</p>;

  // Instead of "modes", we now refer to the aggregation keys.
  const aggKeys = Object.keys(data["Microcensus"]);

  const total_sample_microcensus = Math.round(
    Object.values(data["Microcensus"]).reduce((sum, entry) => sum + entry.sample_size, 0)
  ).toLocaleString();

  const total_sample_synthetic = Math.round(
    Object.values(data["Synthetic"]).reduce((sum, entry) => sum + entry.sample_size, 0)
  ).toLocaleString();

  return (
    <div className="overlay-panel">
      {/* Use alias mapping for display; the aggregation column is shown in a title-friendly way */}
      <h3>
        {cantonAlias[canton] || "All"} - Average Distance by {aggCol ? aggCol : "Aggregation Key"}
      </h3>

      <p>
        <b>Sample Sizes:</b> Microcensus: {total_sample_microcensus}, Synthetic: {total_sample_synthetic}
      </p>

      {/* Euclidean Distance Plot */}
      <Plot
        data={[
          {
            type: "bar",
            x: aggKeys,
            y: aggKeys.map((key) =>
              (data["Microcensus"][key].euclidean_distance / 1000).toFixed(1)
            ),
            name: "Microcensus",
            marker: { color: DATASET_COLORS.Microcensus },
            text: aggKeys.map((key) =>
              (data["Microcensus"][key].euclidean_distance / 1000).toFixed(1)
            ),
            textposition: "auto",
          },
          {
            type: "bar",
            x: aggKeys,
            y: aggKeys.map((key) =>
              (data["Synthetic"][key].euclidean_distance / 1000).toFixed(1)
            ),
            name: "Synthetic",
            marker: { color: DATASET_COLORS.Synthetic },
            text: aggKeys.map((key) =>
              (data["Synthetic"][key].euclidean_distance / 1000).toFixed(1)
            ),
            textposition: "auto",
          },
        ]}
        layout={{
          title: { text: "Euclidean Distance", font: { size: 14 } },
          xaxis: {
            title: { text: aggCol ? aggCol : "Aggregation Key", font: { size: 12 } },
            tickangle: -45,
            tickfont: { size: 10 },
          },
          yaxis: {
            title: { text: "Average Distance [km]", font: { size: 12 } },
            tickfont: { size: 10 },
          },
          margin: { l: 50, r: 20, t: 120, b: 80 },
          height: 350,
          width: 550,
          showlegend: true,
          barmode: "group",
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)",
        }}
      />

      {/* Network Distance Plot */}
      <Plot
        data={[
          {
            type: "bar",
            x: aggKeys,
            y: aggKeys.map((key) =>
              (data["Microcensus"][key].network_distance / 1000).toFixed(1)
            ),
            name: "Microcensus",
            marker: { color: DATASET_COLORS.Microcensus },
            text: aggKeys.map((key) =>
              (data["Microcensus"][key].network_distance / 1000).toFixed(1)
            ),
            textposition: "auto",
          },
          {
            type: "bar",
            x: aggKeys,
            y: aggKeys.map((key) =>
              (data["Synthetic"][key].network_distance / 1000).toFixed(1)
            ),
            name: "Synthetic",
            marker: { color: DATASET_COLORS.Synthetic },
            text: aggKeys.map((key) =>
              (data["Synthetic"][key].network_distance / 1000).toFixed(1)
            ),
            textposition: "auto",
          },
        ]}
        layout={{
          title: { text: "Network Distance", font: { size: 14 } },
          xaxis: {
            title: { text: aggCol ? aggCol : "Aggregation Key", font: { size: 12 } },
            tickangle: -45,
            tickfont: { size: 10 },
          },
          yaxis: {
            title: { text: "Average Distance [km]", font: { size: 12 } },
            tickfont: { size: 10 },
          },
          margin: { l: 50, r: 20, t: 120, b: 80 },
          height: 350,
          width: 550,
          showlegend: true,
          barmode: "group",
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)",
        }}
      />
    </div>
  );
};

export default AverageDist;
