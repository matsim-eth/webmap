import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import { extractSubDataset } from "../../utils/comparisonHelpers";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const DistributionBarPlot = ({
  sidebarCollapsed,
  isExpanded = false,
  dataFile,
  canton,
  title,
  xAxisLabel,
  yAxisLabel = "Percentage [%]",
  dataTransform = null,
  filterType = null,
  customCategories = null,
  yAxisRange = null,
  xAxisRange = null,
  rightLegend = false,
  backendUrlTemplate = null,
  backendQuery = null,
  nestedGroupKey = null,
  exportFilename
}) => {
  const { selectedCanton, selectedIncome, selectedAge, selectedGender, distanceType, comparisonSlots } = useDashboard();
  const { getData } = useData();
  const cantonKey = canton ?? selectedCanton ?? "All";

  useResizeOnSidebarChange(sidebarCollapsed);

  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate, { query: backendQuery });

  // Build per-slot extracted data
  const slotsWithData = useMemo(() => {
    if (backendUrlTemplate) {
      if (isLoading || slotDatasets.length === 0) return null;
      return slotDatasets.map((slot) => {
        const cantonData = slot.rawPayload?.[cantonKey] ?? {};
        let sourceData;
        if (nestedGroupKey) {
          sourceData = cantonData?.[slot.subDataset]?.[nestedGroupKey] ?? {};
        } else {
          sourceData = cantonData?.[slot.subDataset] ?? {};
        }
        return { ...slot, sourceData };
      });
    }

    // File-based fallback: use getData and split by comparison slots
    const jsonData = getData(dataFile);
    if (!jsonData) return null;
    const cantonData = jsonData[cantonKey] || null;
    if (!cantonData) return null;

    return comparisonSlots.filter(Boolean).map((slot) => ({
      ...slot,
      sourceData: cantonData[slot.subDataset] ?? {},
    }));
  }, [backendUrlTemplate, isLoading, slotDatasets, cantonKey, nestedGroupKey, dataFile, getData, comparisonSlots]);

  if (comparisonSlots.length === 0) {
    return <div className="plot-loading">Select a dataset to show data</div>;
  }

  if (!slotsWithData) return <PlotLoader />;

  const resolveGroupedData = (sourceData, key, fallbackKey = null) => {
    if (!sourceData) return null;
    if (key && sourceData[key]) return sourceData[key];
    if (fallbackKey && sourceData[fallbackKey]) return sourceData[fallbackKey];
    return sourceData.All || sourceData.all || null;
  };

  // For each slot, resolve the filtered data
  const resolvedSlots = slotsWithData.map((slot) => {
    let data = slot.sourceData;
    let titleSuffix = "";

    if (filterType === null) {
      // No filter — data is already correct
    } else if (filterType === "income") {
      data = resolveGroupedData(data, selectedIncome);
      titleSuffix = selectedIncome === "all" ? " (All)" : ` (Class ${selectedIncome})`;
    } else if (filterType === "age") {
      data = resolveGroupedData(data, selectedAge);
      titleSuffix = selectedAge === "all" ? " (All)" : ` (${selectedAge})`;
    } else if (filterType === "gender") {
      const genderKey = selectedGender === "male" ? "0" : selectedGender === "female" ? "1" : null;
      data = resolveGroupedData(data, genderKey, selectedGender);
      titleSuffix = selectedGender === "all" ? "" : ` (${selectedGender.charAt(0).toUpperCase() + selectedGender.slice(1)})`;
    } else if (filterType === "distance") {
      // For distance-based data, just use the main data without filtering
      titleSuffix = "";
    }

    return { ...slot, resolvedData: data, titleSuffix };
  });

  // Check we have data for at least one slot
  const validSlots = resolvedSlots.filter((s) => s.resolvedData);
  if (validSlots.length === 0) return <div className="plot-loading">No data available</div>;

  // Determine categories from the UNION of all slots' keys — not just
  // validSlots[0]. An empty `{}` is truthy and passes the validSlots filter,
  // so if the first slot has no data for this metric (e.g. microcensus has no
  // n_activities) taking keys from validSlots[0] alone would blank the whole
  // chart even though a later slot (synthetic) has data. The union keeps the
  // populated slot's ordering since the empty slot contributes nothing.
  let categories;
  if (customCategories) {
    categories = customCategories.map((c) => c.key);
  } else {
    const keySet = new Set();
    for (const s of validSlots) {
      for (const k of Object.keys(s.resolvedData || {})) keySet.add(k);
    }
    categories = [...keySet];
  }

  // Sort distance categories by first slot's average (ascending)
  if (filterType === "distance") {
    const firstData = validSlots[0].resolvedData;
    const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
    categories = [...categories].sort(
      (a, b) => (firstData[a]?.[distKey] || 0) - (firstData[b]?.[distKey] || 0)
    );
  }

  const xLabels = customCategories ? customCategories.map((c) => c.label) : categories;

  const transformValue = (value) => {
    if (dataTransform) return dataTransform(value);
    return value * 100;
  };

  const titleSuffix = resolvedSlots[0]?.titleSuffix ?? "";

  // Build traces — one per slot
  const traces = validSlots.map((slot) => ({
    type: "bar",
    x: xLabels,
    y: categories.map((cat) => {
      const value = slot.resolvedData[cat] || 0;
      if (filterType === "distance") {
        const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
        return transformValue(slot.resolvedData[cat]?.[distKey] || 0);
      }
      return transformValue(value);
    }),
    name: slot.label,
    marker: { color: slot.color },
    text: categories.map((cat) => {
      const value = slot.resolvedData[cat] || 0;
      if (filterType === "distance") {
        const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
        return transformValue(slot.resolvedData[cat]?.[distKey] || 0).toFixed(dataTransform ? 1 : 2);
      }
      return transformValue(value).toFixed(dataTransform ? 1 : 2);
    }),
    textposition: "auto",
  }));

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">
        {filterType === "distance"
          ? title.replace("Average Distance", `Average ${distanceType === "euclidean" ? "Euclidean" : "Network"} Distance`)
          : title + titleSuffix
        }
      </h4>
      <Plot
        data={traces}
        layout={{
          xaxis: {
            title: xAxisLabel,
            type: 'category',
            tickangle: -45,
            tickfont: { size: 9 },
            titlefont: { size: 11 },
            ...(xAxisRange && { range: xAxisRange })
          },
          yaxis: {
            title: {
              text: yAxisLabel,
              font: { size: 11 },
              standoff: 5
            },
            tickfont: { size: 9 },
            ...(yAxisRange && { range: yAxisRange })
          },
          barmode: "group",
          margin: { l: 50, r: 15, t: 5, b: 60 },
          legend: rightLegend
            ? { orientation: 'h', x: 1, xanchor: 'right', y: 1.05, font: { size: 9 } }
            : (isExpanded
              ? { orientation: "v", x: 1.02, y: 1, xanchor: "left", font: { size: 9 } }
              : { orientation: "h", y: 1.05, font: { size: 9 } }),
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

export default DistributionBarPlot;
