import React, { useEffect, useState } from "react";
import "./Table.css"; // Import styles
import cantonAlias from "../utils/canton_alias.json";

// Define mode colors for the legend
const MODE_COLORS = {
  car: "#636efa",
  car_passenger: "#ef553b",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
};

const MODE_LABELS = {
  car: "Car",
  car_passenger: "Car Passenger",
  pt: "Public Transport",
  bike: "Bike",
  walk: "Walking",
};

const CantonModeShareTable = ({ canton, selectedDataset, selectedMode }) => {
  const [modeShareData, setModeShareData] = useState(null);

  useEffect(() => {
    fetch("/data/mode_share.json")
      .then((response) => response.json())
      .then((data) => setModeShareData(data))
      .catch((error) => console.error("Error loading mode share data:", error));
  }, []);

  if (!canton || !modeShareData) return null;

  let modeShares = [];

  if (selectedDataset === "Difference") {
    const micro = modeShareData["Microcensus"].filter(e => e.canton_name === canton);
    const synthetic = modeShareData["Synthetic"].filter(e => e.canton_name === canton);

    const microMap = Object.fromEntries(micro.map(e => [e.mode, e.share]));
    const syntheticMap = Object.fromEntries(synthetic.map(e => [e.mode, e.share]));

    const allModes = new Set([...Object.keys(microMap), ...Object.keys(syntheticMap)]);

    modeShares = Array.from(allModes).map(mode => ({
      mode,
      share: Math.abs((syntheticMap[mode] || 0) - (microMap[mode] || 0))
    }));
  } else {
    modeShares = modeShareData[selectedDataset]?.filter(entry => entry.canton_name === canton);
  }

  return (
    <div className="canton-mode-share">
      <h4>{cantonAlias[canton]}</h4>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>{selectedDataset === "Difference" ? "Abs. Diff (%)" : "Share (%)"}</th>
          </tr>
        </thead>
        <tbody>
          {modeShares.length > 0 ? (
            modeShares.map(({ mode, share }) => (
              <tr
                key={mode}
                className={mode === selectedMode ? "highlight" : ""}
                style={
                  mode === selectedMode
                    ? { backgroundColor: MODE_COLORS[mode], color: "white" }
                    : {}
                }
              >
                <td>{MODE_LABELS[mode]}</td>
                <td>{(share * 100).toFixed(1)}%</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan="2">No data available</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};


export default CantonModeShareTable;
