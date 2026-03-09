import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const DATASET_COLORS = {
  Microcensus: "#4A90E2",
  Synthetic: "#E07A5F",
};

const DistributionBarPlot = ({ 
  sidebarCollapsed, 
  isExpanded = false,
  dataFile,
  title,
  xAxisLabel,
  yAxisLabel = "Percentage [%]", // optional: custom y-axis label
  dataTransform = null, // optional: function to transform data values (e.g., for distance conversion)
  filterType = null, // null, "income", "age", "gender", or "distance"
  customCategories = null, // optional: provide custom categories and their data keys
  yAxisRange = null, // optional: [min, max] for fixed y-axis range
  xAxisRange = null, // optional: [min, max] for fixed x-axis range
  rightLegend = false, // optional: position legend on right side
  exportFilename
}) => {
  const { selectedCanton, selectedIncome, selectedAge, selectedGender, distanceType } = useDashboard();
  const [data, setData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 100);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const cantonKey = selectedCanton || "All";
    
    loadWithFallback(dataFile)
      .then((jsonData) => {
        if (jsonData[cantonKey]) {
          setData(jsonData[cantonKey]);
        }
      })
      .catch((error) => console.error("Error loading data:", error));
  }, [selectedCanton, dataFile]);

  if (!data) return <div className="plot-loading">Loading...</div>;

  // Determine what data to show based on filterType
  let categories, microData, synData, titleSuffix = "";

  if (filterType === null) {
    // General distribution - no filter
    if (customCategories) {
      // Use custom categories for cases like gender (Male/Female mapped to 0/1)
      microData = data["Microcensus"];
      synData = data["Synthetic"];
      categories = customCategories.map(c => c.key);
    } else {
      categories = Object.keys(data["Microcensus"]);
      microData = data["Microcensus"];
      synData = data["Synthetic"];
    }
  } else if (filterType === "income") {
    microData = data["Microcensus"][selectedIncome];
    synData = data["Synthetic"][selectedIncome];
    titleSuffix = ` (Class ${selectedIncome})`;
  } else if (filterType === "age") {
    microData = data["Microcensus"][selectedAge];
    synData = data["Synthetic"][selectedAge];
    titleSuffix = ` (${selectedAge})`;
  } else if (filterType === "gender") {
    const genderKey = selectedGender === "male" ? "0" : "1";
    microData = data["Microcensus"][genderKey];
    synData = data["Synthetic"][genderKey];
    titleSuffix = ` (${selectedGender.charAt(0).toUpperCase() + selectedGender.slice(1)})`;
  } else if (filterType === "distance") {
    // For distance-based data, just use the main data without filtering
    microData = data["Microcensus"];
    synData = data["Synthetic"];
    titleSuffix = "";
  }

  if (!microData || !synData) return <div className="plot-loading">No data available</div>;

  // Get categories - use customCategories if provided, otherwise get from data
  if (!categories) {
    if (customCategories) {
      categories = customCategories.map(c => c.key);
    } else {
      categories = Object.keys(microData);
    }
  }

  // Determine x-axis labels
  const xLabels = customCategories 
    ? customCategories.map(c => c.label) 
    : categories;

  // Transform data function - handles both percentage and custom transformations
  const transformValue = (value) => {
    if (dataTransform) {
      return dataTransform(value);
    }
    return value * 100; // Default: convert to percentage
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">
        {filterType === "distance" 
          ? title.replace("Average Distance", `Average ${distanceType === "euclidean" ? "Euclidean" : "Network"} Distance`)
          : title + titleSuffix
        }
      </h4>
      <Plot
        data={[
          {
            type: "bar",
            x: xLabels,
            y: categories.map((cat) => {
              const value = microData[cat] || 0;
              if (filterType === "distance") {
                const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
                return transformValue(microData[cat]?.[distKey] || 0);
              }
              return transformValue(value);
            }),
            name: "Microcensus",
            marker: { color: DATASET_COLORS.Microcensus },
            text: categories.map((cat) => {
              const value = microData[cat] || 0;
              if (filterType === "distance") {
                const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
                return transformValue(microData[cat]?.[distKey] || 0).toFixed(dataTransform ? 1 : 2);
              }
              return transformValue(value).toFixed(dataTransform ? 1 : 2);
            }),
            textposition: "auto",
          },
          {
            type: "bar",
            x: xLabels,
            y: categories.map((cat) => {
              const value = synData[cat] || 0;
              if (filterType === "distance") {
                const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
                return transformValue(synData[cat]?.[distKey] || 0);
              }
              return transformValue(value);
            }),
            name: "Synthetic",
            marker: { color: DATASET_COLORS.Synthetic },
            text: categories.map((cat) => {
              const value = synData[cat] || 0;
              if (filterType === "distance") {
                const distKey = distanceType === "euclidean" ? "euclidean_distance" : "network_distance";
                return transformValue(synData[cat]?.[distKey] || 0).toFixed(dataTransform ? 1 : 2);
              }
              return transformValue(value).toFixed(dataTransform ? 1 : 2);
            }),
            textposition: "auto",
          },
        ]}
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
