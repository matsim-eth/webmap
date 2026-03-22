import React from "react";
import "./ChoroplethControls.css";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";

const COLOR_MAPS = {
  mode: {
    car: "#636efa",
    car_passenger: "#ef553b",
    pt: "#00cc96",
    bike: "#ab63fa",
    walk: "#ffa15a",
  },
  purpose: {
    education: "#636efa",
    home: "#ef553b",
    leisure: "#00cc96",
    other: "#ab63fa",
    shop: "#ffa15a",
    work: "#FFEE8C",
  },
};

const LABEL_MAPS = {
  mode: {
    car: "Car",
    car_passenger: "Car Passenger",
    pt: "Public Transport",
    bike: "Bike",
    walk: "Walking",
  },
  purpose: {
    education: "Education",
    home: "Home",
    leisure: "Leisure",
    other: "Other",
    shop: "Shop",
    work: "Work",
  },
};

const ChoroplethControls = ({
  selectedMode,
  setSelectedMode,
  selectedDataset,
  setSelectedDataset,
  updateMapChoropleth,
  aggCol = "mode",
  setAggCol,
}) => {
  const loadWithFallback = useLoadWithFallback();

  const COLORS = COLOR_MAPS[aggCol] || {};
  const LABELS = LABEL_MAPS[aggCol] || {};

  const { data: maxSharePerMode = null } = useQuery({
    queryKey: ['max-share-per-mode', aggCol],
    queryFn: () => loadWithFallback(`${aggCol}_share.json`).then((data) => {
      const maxKey = `max_share_per_${aggCol}`;
      return data[maxKey] ?? null;
    }),
  });

  const handleModeChange = (e) => {
    const newMode = e.target.value;
    setSelectedMode(newMode);
    updateMapChoropleth(newMode, selectedDataset);
  };

  return (
    <div className="choropleth-controls">
      {setAggCol && (
        <div className="group-by-section">
          <label>Group By:</label>
          <div className="group-by-toggle">
            {[
              { value: "mode", label: "Mode" },
              { value: "purpose", label: "Purpose" },
            ].map((opt) => (
              <button
                key={opt.value}
                className={`group-by-option ${aggCol === opt.value ? "active" : ""}`}
                onClick={() => {
                  setAggCol(opt.value);
                  setSelectedMode("None");
                  updateMapChoropleth("None", selectedDataset);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <label>Select {aggCol === "mode" ? "Mode" : "Purpose"}:</label>
      <select value={selectedMode} onChange={handleModeChange}>
        <option value="None">None</option>
        {Object.keys(LABELS).map((key) => (
          <option key={key} value={key}>
            {LABELS[key]}
          </option>
        ))}
      </select>

      <div className="dataset-selector">
        {["Microcensus", "Synthetic", "Difference"].map((option) => (
          <button
            key={option}
            className={`dataset-option ${selectedDataset === option ? "active" : ""}`}
            onClick={() => {
              setSelectedDataset(option);
              updateMapChoropleth(selectedMode, option);
            }}
          >
            {option}
          </button>
        ))}
      </div>

      {/* Legend */}
      {selectedMode !== "None" && (
        <div className="legend">
          <h4>Legend</h4>
          <div className="legend-container">
            <span className="legend-label">0%</span>
            <div
              className="legend-gradient"
              style={{
                background:
                  selectedDataset === "Difference"
                    ? "linear-gradient(to left, red 0%, white 100%)"
                    : `linear-gradient(to left, ${COLORS[selectedMode] || "#888"} 0%, #FFFFFF 100%)`,
              }}
            ></div>
            <span className="legend-label">
              {selectedDataset === "Difference"
                ? "10%"
                : maxSharePerMode?.[selectedMode]
                  ? `${Math.round(maxSharePerMode[selectedMode] * 100)}%`
                  : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChoroplethControls;
