import React, { useEffect, useState } from "react";
import "./Table.css";
import cantonAlias from "../utils/canton_alias.json";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

// --- Color & label maps ---
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

const CantonModeShareTable = ({
  canton,
  selectedDataset,
  selectedMode,
  aggCol = "mode", // "mode" or "purpose"
}) => {
  const [shareData, setShareData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  const COLORS = COLOR_MAPS[aggCol] || {};
  const LABELS = LABEL_MAPS[aggCol] || {};

  useEffect(() => {
    loadWithFallback(`${aggCol}_share.json`)
      .then((data) => setShareData(data))
      .catch((error) =>
        console.error(`Error loading ${aggCol}_share data:`, error)
      );
  }, [aggCol]);

  if (!canton || !shareData) return null;

  let items = [];

  if (selectedDataset === "Difference") {
    const micro = shareData["Microcensus"].filter(
      (e) => e.canton_name === canton
    );
    const synthetic = shareData["Synthetic"].filter(
      (e) => e.canton_name === canton
    );

    const microMap = Object.fromEntries(micro.map((e) => [e[aggCol], e.share]));
    const syntheticMap = Object.fromEntries(
      synthetic.map((e) => [e[aggCol], e.share])
    );

    const allKeys = new Set([
      ...Object.keys(microMap),
      ...Object.keys(syntheticMap),
    ]);

    items = Array.from(allKeys).map((key) => ({
      key,
      share: Math.abs((syntheticMap[key] || 0) - (microMap[key] || 0)),
    }));
  } else {
    items = shareData[selectedDataset]?.filter(
      (entry) => entry.canton_name === canton
    ).map((e) => ({ key: e[aggCol], share: e.share })) || [];
  }

  return (
    <div className="canton-mode-share">
      <h4>{cantonAlias[canton]}</h4>
      <table>
        <thead>
          <tr>
            <th>{aggCol === "mode" ? "Mode" : "Purpose"}</th>
            <th>{selectedDataset === "Difference" ? "Abs. Diff (%)" : "Share (%)"}</th>
          </tr>
        </thead>
        <tbody>
          {items.length > 0 ? (
            items.map(({ key, share }) => (
              <tr
                key={key}
                className={key === selectedMode ? "highlight" : ""}
                style={
                  key === selectedMode
                    ? {
                        backgroundColor: COLORS[key] || "#888",
                        color: "white",
                      }
                    : {}
                }
              >
                <td>{LABELS[key] || key}</td>
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
