import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import cantonAlias from "../utils/canton_alias.json";

const DATASET_COLORS = {
  Microcensus: "#4A90E2",
  Synthetic: "#E07A5F",
};

const Histogram = ({ canton, aggCol, dataURL }) => {
  const [euclideanData, setEuclideanData] = useState(null);
  const [networkData, setNetworkData] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);

  useEffect(() => {
    const selectedCanton = canton || "All";
    const aggregation = aggCol || "mode";

    // Fetch Euclidean histogram data based on aggregation
    fetch(`${dataURL}histogram_euclidean_distance_${aggregation}.json`)
      .then((response) => response.json())
      .then((jsonData) => {
        if (jsonData[selectedCanton]) {
          setEuclideanData(jsonData[selectedCanton]);
          // Default to the first aggregation key
          setSelectedKey(Object.keys(jsonData[selectedCanton])[0]);
        }
      })
      .catch((error) => console.error("Error loading Euclidean JSON:", error));

    // Fetch Network histogram data
    fetch(`${dataURL}histogram_network_distance_${aggregation}.json`)
      .then((response) => response.json())
      .then((jsonData) => {
        if (jsonData[selectedCanton]) {
          setNetworkData(jsonData[selectedCanton]);
        }
      })
      .catch((error) => console.error("Error loading Network JSON:", error));
  }, [canton, aggCol]);

  if (!euclideanData || !networkData || !selectedKey) return <p>Loading...</p>;

  const handleKeyChange = (event) => {
    setSelectedKey(event.target.value);
  };

  // Calculate maximum Y from both datasets for the selected aggregation key
  const maxY = Math.max(
    ...euclideanData[selectedKey].microcensus_histogram,
    ...euclideanData[selectedKey].synthetic_histogram,
    ...networkData[selectedKey].microcensus_histogram,
    ...networkData[selectedKey].synthetic_histogram
  );

  // In our JSON, each aggregation key record is expected to contain:
  // bins, bin_width, microcensus_histogram, synthetic_histogram, microcensus_mean, synthetic_mean, etc.
  const renderPlot = (data, title) => {
    const binWidth = data[selectedKey].bin_width;
    const bins = data[selectedKey].bins;
    const microMean = data[selectedKey].microcensus_mean;
    const synthMean = data[selectedKey].synthetic_mean;

    return (
      <Plot
        key={title}
        data={[
          {
            type: "bar",
            x: bins,
            y: data[selectedKey].microcensus_histogram,
            name: "Microcensus",
            marker: { color: DATASET_COLORS.Microcensus },
            opacity: 0.6,
            hoverinfo: "x+y",
            hovertemplate: "Range: [%{x:.1f} - %{customdata})<br>Percentage: %{y:.2f}%",
            customdata: bins.map((b) => (b + binWidth).toFixed(1)),
          },
          {
            type: "bar",
            x: bins,
            y: data[selectedKey].synthetic_histogram,
            name: "Synthetic",
            marker: { color: DATASET_COLORS.Synthetic },
            opacity: 0.6,
            hoverinfo: "x+y",
            hovertemplate: "Range: [%{x:.1f} - %{customdata})<br>Percentage: %{y:.2f}%",
            customdata: bins.map((b) => (b + binWidth).toFixed(1)),
          },
          // Microcensus mean line (draw line with two points)
          {
            type: "scatter",
            mode: "lines",
            x: [microMean, microMean],
            y: [0, maxY * 0.8],
            name: "Microcensus Mean",
            line: { color: DATASET_COLORS.Microcensus, dash: "dot" },
            hoverinfo: "x",
            legendgroup: "microcensus-mean",
          },
          // Microcensus mean text label
          {
            type: "scatter",
            mode: "text",
            x: [microMean],
            y: [maxY * 0.8],
            text: [`${microMean.toFixed(1)}`],
            textposition: "top center",
            showlegend: false,
            hoverinfo: "skip",
            legendgroup: "microcensus-mean",
          },
          // Synthetic mean line
          {
            type: "scatter",
            mode: "lines",
            x: [synthMean, synthMean],
            y: [0, maxY * 0.65],
            name: "Synthetic Mean",
            line: { color: DATASET_COLORS.Synthetic, dash: "dot" },
            hoverinfo: "x",
            legendgroup: "synthetic-mean",
          },
          // Synthetic mean text label
          {
            type: "scatter",
            mode: "text",
            x: [synthMean],
            y: [maxY * 0.65],
            text: [`${synthMean.toFixed(1)}`],
            textposition: "top center",
            showlegend: false,
            hoverinfo: "skip",
            legendgroup: "synthetic-mean",
          },
        ]}
        layout={{
          title: { text: `${title}: ${aggCol} = ${selectedKey}`, font: { size: 14 } },
          xaxis: {
            title: { text: "Distance [m]", font: { size: 12 } },
            tickfont: { size: 10 },
            range: [-binWidth, binWidth * 25],
          },
          yaxis: {
            title: { text: "Percentage [%]", font: { size: 12 } },
            tickfont: { size: 10 },
            range: [0, 1.1 * maxY],
          },
          margin: { l: 60, r: 20, t: 80, b: 50 },
          height: 300,
          width: 550,
          showlegend: true,
          barmode: "overlay",
          bargap: 0,
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)",
          annotations: [
            {
              x: 1.45,
              y: 0.1,
              xref: "paper",
              yref: "paper",
              text: `Microcensus: n=${data[selectedKey].microcensus_sample_size}<br>Synthetic: n=${data[selectedKey].synthetic_sample_size}`,
              showarrow: false,
              font: { size: 12 },
              align: "center",
            },
          ],
        }}
      />
    );
  };

  return (
    <div className="overlay-panel">
      <h3>{cantonAlias[canton] || "All"} - Distance Histograms by {aggCol}</h3>
      <div>
        {Object.keys(euclideanData).map((key) => (
          <label key={key}>
            <input
              type="radio"
              name="aggregation-key"
              value={key}
              checked={selectedKey === key}
              onChange={handleKeyChange}
            />
            {key}
          </label>
        ))}
      </div>
      <h4>Euclidean Distance</h4>
      {renderPlot(euclideanData, "Euclidean Distance")}
      <h4>Network Distance</h4>
      {renderPlot(networkData, "Network Distance")}
    </div>
  );
};

export default Histogram;
