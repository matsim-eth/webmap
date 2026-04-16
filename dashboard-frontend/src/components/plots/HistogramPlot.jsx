import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import { extractHistogramData } from "../../utils/comparisonHelpers";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const HistogramPlot = ({
  sidebarCollapsed,
  isExpanded = false,
  plotType = 'distance',
  type = 'mode',
  title,
  xAxisLabel,
  dataFile,
  backendUrlTemplate = null,
  dataTransform = (val) => val * 100,
  exportFilename
}) => {
  const { selectedCanton, distanceType, selectedMode, selectedPurpose, comparisonSlots } = useDashboard();
  const { getData } = useData();

  const selectedFilter = type === 'mode' ? selectedMode : selectedPurpose;
  const activityFilter = selectedPurpose;

  useResizeOnSidebarChange(sidebarCollapsed);

  const cantonKey = selectedCanton || "All";

  // Distance plots need distance_type suffix
  const distSuffix = plotType === 'distance'
    ? `distance_type=${distanceType === "euclidean" ? "euclidean" : "network"}`
    : null;

  // Always call both hooks (React rules) — only one will be enabled at a time
  const { slotDatasets: distSlots, isLoading: distLoading, isFetching: distFetching } = useComparisonData(
    plotType === 'distance' ? backendUrlTemplate : null,
    { urlSuffix: distSuffix }
  );
  const { slotDatasets: singleSlots, isLoading: singleLoading, isFetching: singleFetching } = useComparisonData(
    plotType !== 'distance' ? backendUrlTemplate : null
  );
  const isFetching = distFetching || singleFetching;

  // === Distance plot data (always computed, just returns null when not distance) ===
  const slotsWithHisto = useMemo(() => {
    if (plotType !== 'distance') return null;

    if (backendUrlTemplate) {
      if (distLoading || distSlots.length === 0) return null;
      const firstPayload = distSlots[0]?.rawPayload?.[cantonKey];
      if (!firstPayload) return null;
      const availableOptions = Object.keys(firstPayload);
      const currentOption = selectedFilter === "all"
        ? (availableOptions.includes("All") ? "All" : availableOptions[0])
        : selectedFilter;

      return distSlots.map((slot) => {
        const histo = extractHistogramData(slot.rawPayload, cantonKey, currentOption, slot.subDataset);
        return { ...slot, histo, currentOption };
      }).filter((s) => s.histo);
    }

    // File fallback
    const filename = distanceType === "euclidean"
      ? `histogram_euclidean_distance_${type}.json`
      : `histogram_network_distance_${type}.json`;
    const raw = getData(filename);
    const cantonData = raw?.[cantonKey];
    if (!cantonData) return null;

    const availableOptions = Object.keys(cantonData);
    const currentOption = selectedFilter === "all"
      ? (availableOptions.includes("All") ? "All" : availableOptions[0])
      : selectedFilter;

    return comparisonSlots.filter(Boolean).map((slot) => {
      const histo = extractHistogramData({ [cantonKey]: cantonData }, cantonKey, currentOption, slot.subDataset);
      return { ...slot, histo, currentOption };
    }).filter((s) => s.histo);
  }, [plotType, backendUrlTemplate, distLoading, distSlots, cantonKey, selectedFilter, distanceType, type, getData, comparisonSlots]);

  // === Duration/Departure plot data (always computed, just returns null when distance) ===
  const slotsWithActivity = useMemo(() => {
    if (plotType === 'distance') return null;

    if (backendUrlTemplate) {
      if (singleLoading || singleSlots.length === 0) return null;
      return singleSlots.map((slot) => {
        const cantonData = slot.rawPayload?.[cantonKey] ?? {};
        const sourceData = cantonData?.[slot.subDataset] ?? {};
        return { ...slot, sourceData };
      });
    }

    const raw = getData(dataFile);
    const cantonData = raw?.[cantonKey];
    if (!cantonData) return null;

    return comparisonSlots.filter(Boolean).map((slot) => ({
      ...slot,
      sourceData: cantonData?.[slot.subDataset] ?? {},
    }));
  }, [plotType, backendUrlTemplate, singleLoading, singleSlots, cantonKey, dataFile, getData, comparisonSlots]);

  if (comparisonSlots.length === 0) {
    return <div className="plot-loading">Select a dataset to show data</div>;
  }

  // === DISTANCE PLOT RENDER ===
  if (plotType === 'distance') {
    if (!slotsWithHisto || slotsWithHisto.length === 0) return <PlotLoader />;

    const distanceLabel = distanceType === "euclidean" ? "Euclidean" : "Network";
    const currentOption = slotsWithHisto[0].currentOption;
    const binWidth = slotsWithHisto[0].histo.binWidth;
    const bins = slotsWithHisto[0].histo.bins;

    const maxY = Math.max(
      ...slotsWithHisto.flatMap((s) => s.histo.histogram)
    );

    // Mean line heights — stagger them so they don't overlap
    const meanHeights = [0.8, 0.65, 0.5, 0.35];

    const traces = slotsWithHisto.flatMap((slot, idx) => {
      const h = slot.histo;
      const meanH = meanHeights[idx] ?? 0.5;
      return [
        {
          type: "bar",
          x: bins,
          y: h.histogram,
          name: slot.label,
          marker: { color: slot.color },
          opacity: 0.6,
          hovertemplate: "Range: [%{x:.1f} - %{customdata})<br>Percentage: %{y:.2f}%",
          customdata: bins.map((b) => (b + binWidth).toFixed(1)),
        },
        {
          type: "scatter",
          mode: "lines",
          x: [h.mean, h.mean],
          y: [0, maxY * meanH],
          name: `${slot.label} Mean`,
          line: { color: slot.color, dash: "dot" },
          hoverinfo: "x",
          legendgroup: `mean-${idx}`,
        },
        {
          type: "scatter",
          mode: "text",
          x: [h.mean],
          y: [maxY * meanH],
          text: [`${h.mean.toFixed(1)}`],
          textposition: "top center",
          showlegend: false,
          hoverinfo: "skip",
          legendgroup: `mean-${idx}`,
        },
      ];
    });

    // Sample size annotation
    const sampleText = slotsWithHisto
      .map((s) => `n(${s.label})=${s.histo.sampleSize}`)
      .join("<br>");

    return (
      <div className="plot-wrapper">
        {isFetching && <PlotLoadingOverlay />}
        <h4 className="plot-title">{distanceLabel} Distance ({currentOption})</h4>
        <Plot
          key={`distance-${currentOption}-${distanceType}`}
          data={traces}
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
                text: sampleText,
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

  // === DURATION / DEPARTURE PLOTS RENDER ===
  if (!slotsWithActivity) return <PlotLoader />;

  // Determine activity options from first slot
  const firstSourceData = slotsWithActivity[0]?.sourceData;
  if (!firstSourceData || Object.keys(firstSourceData).length === 0) {
    return <div className="plot-loading">No data available</div>;
  }

  const availableOptions = Object.keys(firstSourceData);
  let currentActivity = activityFilter;
  if (activityFilter === 'all') {
    currentActivity = availableOptions.includes('All') ? 'All' : availableOptions[0];
  }

  const firstActivityData = firstSourceData[currentActivity];
  if (!firstActivityData) return <div className="plot-loading">No data available</div>;

  const items = Object.keys(firstActivityData);
  const hoverLabel = plotType === 'duration' ? 'Duration' : 'Time';

  const traces = slotsWithActivity.map((slot) => {
    const activityData = slot.sourceData?.[currentActivity] ?? {};
    return {
      type: 'bar',
      x: items,
      y: items.map((i) => (activityData[i] || 0) * dataTransform(1)),
      name: slot.label,
      marker: { color: slot.color },
      opacity: 0.6,
      hovertemplate: `${hoverLabel}: %{x}<br>Percentage: %{y:.2f}%<extra></extra>`,
    };
  });

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">{title} ({currentActivity})</h4>
      <Plot
        data={traces}
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
