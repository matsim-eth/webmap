import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import { LINE_STYLES } from "../../utils/comparisonHelpers";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

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
  plotType = 'departure',
  title,
  xAxisLabel,
  backendUrlTemplate = null,
  exportFilename
}) => {
  const { selectedCanton, distanceType, selectedMode, selectedPurpose, comparisonSlots } = useDashboard();
  const { getData } = useData();

  const colors = type === 'mode' ? MODE_COLORS : PURPOSE_COLORS;
  const selectedFilter = type === 'mode' ? selectedMode : selectedPurpose;

  useResizeOnSidebarChange(sidebarCollapsed);

  // Build URL suffix based on plotType
  const urlSuffix = useMemo(() => {
    if (plotType === 'departure') return 'metric=departure_time';
    const metric = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
    return `metric=${metric}`;
  }, [plotType, distanceType]);

  const cantonKey = selectedCanton || "All";

  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate, { urlSuffix });

  // Resolve per-slot line data
  const slotsWithLineData = useMemo(() => {
    if (backendUrlTemplate) {
      if (isLoading || slotDatasets.length === 0) return null;
      return slotDatasets.map((slot) => {
        const plotData = slot.rawPayload?.[cantonKey] || null;
        // Line data uses lowercase keys: plotData.microcensus / plotData.synthetic
        const lineData = plotData?.[slot.subDataset.toLowerCase()] ?? null;
        const tickVals = plotData?.tick_vals || [];
        const tickLabels = plotData?.tick_labels || [];
        return { ...slot, lineData, tickVals, tickLabels };
      });
    }

    // File fallback
    let filename;
    if (plotType === 'departure') {
      filename = `lineplot_departure_time_data_${type}.json`;
    } else {
      const selectedVariable = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
      filename = `lineplot_${selectedVariable}_data_${type}.json`;
    }
    const raw = getData(filename);
    const plotData = raw?.[cantonKey] || null;
    if (!plotData) return null;

    return comparisonSlots.filter(Boolean).map((slot) => ({
      ...slot,
      lineData: plotData[slot.subDataset.toLowerCase()] ?? null,
      tickVals: plotData.tick_vals || [],
      tickLabels: plotData.tick_labels || [],
    }));
  }, [backendUrlTemplate, isLoading, slotDatasets, cantonKey, plotType, type, distanceType, getData, comparisonSlots]);

  if (comparisonSlots.length === 0) {
    return <div className="plot-loading">Select a dataset to show data</div>;
  }

  if (!slotsWithLineData) return <PlotLoader />;

  const validSlots = slotsWithLineData.filter((s) => s.lineData);
  if (validSlots.length === 0) return <PlotLoader />;

  // Generate data traces per slot
  const generateTraces = (data, lineStyle, slotLabel) => {
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

  const traces = validSlots.flatMap((slot, idx) =>
    generateTraces(slot.lineData, LINE_STYLES[idx] || "solid", slot.label)
  );

  // Dummy traces for color legend (mode/purpose squares)
  const items = selectedFilter === "all" ? Object.keys(colors) : [selectedFilter];
  const colorTraces = items.map((item) => ({
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

  // Dummy traces for line style legend — one per slot
  const lineStyleTraces = validSlots.map((slot, idx) => ({
    type: "scatter",
    mode: "lines",
    x: [null],
    y: [null],
    name: slot.label,
    line: { color: "#666", dash: LINE_STYLES[idx] || "solid", width: 2 },
    showlegend: true,
    legendgroup: "linestyle",
    legendrank: 2,
  }));

  const allTraces = [...traces, ...colorTraces, ...lineStyleTraces];

  // Tick labels from first valid slot
  const tickVals = validSlots[0].tickVals;
  const tickLabels = validSlots[0].tickLabels;
  const filteredTickVals = plotType === 'departure' ? tickVals.filter((_, i) => i % 2 === 0) : tickVals;
  const filteredTickLabels = plotType === 'departure' ? tickLabels.filter((_, i) => i % 2 === 0) : tickLabels;

  let displayTitle = title;
  if (plotType === 'distance') {
    const distanceLabel = distanceType === "euclidean" ? "Euclidean Distance" : "Network Distance";
    displayTitle = `${type.charAt(0).toUpperCase() + type.slice(1)} Share by ${distanceLabel}`;
  }

  let displayXLabel = xAxisLabel;
  if (plotType === 'distance') {
    displayXLabel = distanceType === "euclidean" ? "Euclidean Distance" : "Network Distance";
  }

  const marginBottom = plotType === 'distance' ? 70 : 65;

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
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
