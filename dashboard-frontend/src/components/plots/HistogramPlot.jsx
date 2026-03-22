import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";

const DATASET_COLORS = {
  Microcensus: "#4A90E2",
  Synthetic: "#E07A5F",
};

const HistogramPlot = ({
  sidebarCollapsed,
  isExpanded = false,
  plotType = 'distance', // 'distance', 'duration', or 'departure'
  type = 'mode', // for distance plots: 'mode' or 'purpose'
  title,
  xAxisLabel,
  dataFile,
  backendUrl = null,
  dataTransform = (val) => val * 100, // convert fraction to percentage
  exportFilename
}) => {
  const { selectedCanton, distanceType, selectedMode, selectedPurpose } = useDashboard();
  const { getData, getUrlData } = useData();

  // Use mode or purpose based on type prop (for distance plots)
  const selectedFilter = type === 'mode' ? selectedMode : selectedPurpose;

  // For duration/departure plots, use selectedPurpose
  const activityFilter = selectedPurpose;

  useResizeOnSidebarChange(sidebarCollapsed);

  const cantonKey = selectedCanton || "All";

  // Fetch from backend for duration/departure plots
  const { data: backendData } = useQuery({
    queryKey: ['histogramSingle', backendUrl, cantonKey],
    queryFn: () => getUrlData(backendUrl).then((payload) => payload?.[cantonKey] ?? {}),
    enabled: !!backendUrl && plotType !== 'distance',
  });

  // Fetch both euclidean and network from backend for distance plots
  const sep = backendUrl?.includes('?') ? '&' : '?';
  const { data: backendDistanceData } = useQuery({
    queryKey: ['histogramDistance', backendUrl, cantonKey],
    queryFn: () =>
      Promise.all([
        getUrlData(`${backendUrl}${sep}distance_type=euclidean`),
        getUrlData(`${backendUrl}${sep}distance_type=network`),
      ]).then(([euc, net]) => ({
        euclidean: euc?.[cantonKey] || null,
        network: net?.[cantonKey] || null,
      })),
    enabled: !!backendUrl && plotType === 'distance',
  });
  const backendEuclidean = backendDistanceData?.euclidean ?? null;
  const backendNetwork = backendDistanceData?.network ?? null;

  const euclideanData = useMemo(() => {
    if (plotType !== 'distance') return null;
    if (backendUrl) return backendEuclidean;
    const raw = getData(`histogram_euclidean_distance_${type}.json`);
    return raw?.[cantonKey] || null;
  }, [getData, type, plotType, cantonKey, backendUrl, backendEuclidean]);

  const networkData = useMemo(() => {
    if (plotType !== 'distance') return null;
    if (backendUrl) return backendNetwork;
    const raw = getData(`histogram_network_distance_${type}.json`);
    return raw?.[cantonKey] || null;
  }, [getData, type, plotType, cantonKey, backendUrl, backendNetwork]);

  const singleData = useMemo(() => {
    if (plotType === 'distance') return null;
    if (backendUrl) return backendData ?? null;
    const raw = getData(dataFile);
    return raw?.[cantonKey] || null;
  }, [getData, dataFile, plotType, cantonKey, backendUrl, backendData]);

  // Distance plot logic
  if (plotType === 'distance') {
    if (!euclideanData || !networkData) return <div className="plot-loading">Loading...</div>;

    const availableOptions = Object.keys(euclideanData);
    const currentOption = selectedFilter === "all"
      ? (availableOptions.includes("All") ? "All" : availableOptions[0])
      : selectedFilter;

    if (!euclideanData[currentOption] || !networkData[currentOption]) {
      return <div className="plot-loading">No data for selected {type}</div>;
    }

    const data = distanceType === "euclidean" ? euclideanData : networkData;
    const distanceLabel = distanceType === "euclidean" ? "Euclidean" : "Network";

    const binWidth = data[currentOption].bin_width;
    const bins = data[currentOption].bins;
    const microMean = data[currentOption].microcensus_mean;
    const synthMean = data[currentOption].synthetic_mean;

    const maxY = Math.max(
      ...euclideanData[currentOption].microcensus_histogram,
      ...euclideanData[currentOption].synthetic_histogram,
      ...networkData[currentOption].microcensus_histogram,
      ...networkData[currentOption].synthetic_histogram
    );

    return (
      <div className="plot-wrapper">
        <h4 className="plot-title">{distanceLabel} Distance ({currentOption})</h4>
        <Plot
          key={`distance-${currentOption}-${distanceType}`}
          data={[
            {
              type: "bar",
              x: bins,
              y: data[currentOption].microcensus_histogram,
              name: "Microcensus",
              marker: { color: DATASET_COLORS.Microcensus },
              opacity: 0.6,
              hovertemplate: "Range: [%{x:.1f} - %{customdata})<br>Percentage: %{y:.2f}%",
              customdata: bins.map((b) => (b + binWidth).toFixed(1)),
            },
            {
              type: "bar",
              x: bins,
              y: data[currentOption].synthetic_histogram,
              name: "Synthetic",
              marker: { color: DATASET_COLORS.Synthetic },
              opacity: 0.6,
              hovertemplate: "Range: [%{x:.1f} - %{customdata})<br>Percentage: %{y:.2f}%",
              customdata: bins.map((b) => (b + binWidth).toFixed(1)),
            },
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
            xaxis: {
              title: { text: "Distance [m]", font: { size: 11 } },
              tickfont: { size: 9 },
              range: [-binWidth, binWidth * 25],
            },
            yaxis: {
              title: { text: "Percentage [%]", font: { size: 11 } },
              tickfont: { size: 9 },
              range: [0, 1.1 * maxY],
            },
            margin: { l: 45, r: 20, t: 5, b: 40 },
            showlegend: true,
            legend: {
              orientation: "v",
              x: 1.02,
              y: 1,
              xanchor: "left",
              yanchor: "top",
              font: { size: 8 },
            },
            barmode: "overlay",
            bargap: 0,
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            autosize: true,
            annotations: [
              {
                x: 1.02,
                y: 0.0,
                xref: "paper",
                yref: "paper",
                text: `n(MC)=${data[currentOption].microcensus_sample_size}<br>n(Syn)=${data[currentOption].synthetic_sample_size}`,
                showarrow: false,
                font: { size: 8 },
                align: "left",
                xanchor: "left",
                yanchor: "bottom",
              },
            ],
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
  }

  // Duration/Departure plots logic
  if (!singleData) return <div className="plot-loading">Loading...</div>;

  const availableOptions = Object.keys(singleData.Microcensus || {});
  let currentActivity = activityFilter;

  if (activityFilter === 'all') {
    currentActivity = availableOptions.includes('All') ? 'All' : availableOptions[0];
  }

  const microcensusActivityData = singleData.Microcensus?.[currentActivity];
  const syntheticActivityData = singleData.Synthetic?.[currentActivity];

  if (!microcensusActivityData || !syntheticActivityData) {
    return <div className="plot-loading">No data available</div>;
  }

  const items = Object.keys(microcensusActivityData);
  const hoverLabel = plotType === 'duration' ? 'Duration' : 'Time';

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{title} ({currentActivity})</h4>
      <Plot
        data={[
          {
            type: 'bar',
            x: items,
            y: items.map((i) => (microcensusActivityData[i] || 0) * dataTransform(1)),
            name: 'Microcensus',
            marker: { color: DATASET_COLORS.Microcensus },
            opacity: 0.6,
            hovertemplate: `${hoverLabel}: %{x}<br>Percentage: %{y:.2f}%<extra></extra>`,
          },
          {
            type: 'bar',
            x: items,
            y: items.map((i) => (syntheticActivityData[i] || 0) * dataTransform(1)),
            name: 'Synthetic',
            marker: { color: DATASET_COLORS.Synthetic },
            opacity: 0.6,
            hovertemplate: `${hoverLabel}: %{x}<br>Percentage: %{y:.2f}%<extra></extra>`,
          },
        ]}
        layout={{
          xaxis: {
            title: xAxisLabel,
            tickangle: -45,
            tickfont: { size: 9 },
            titlefont: { size: 11 },
          },
          yaxis: {
            title: {
              text: 'Percentage [%]',
              font: { size: 11 },
              standoff: 5
            },
            tickfont: { size: 9 },
          },
          barmode: 'overlay',
          bargap: 0,
          margin: { l: 50, r: 15, t: 5, b: 60 },
          legend: {
            orientation: 'h',
            x: 1,
            xanchor: 'right',
            y: 1.05,
            yanchor: 'bottom',
            font: { size: 8 },
          },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          autosize: true,
        }}
        useResizeHandler={true}
        style={{ width: '100%', height: '100%' }}
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

export default HistogramPlot;
