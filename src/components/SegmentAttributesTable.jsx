import React from "react";
import "./Table.css"; // Reuse the same CSS

const format = (value, isSpeed = false) => {
  if (isSpeed) return `${Math.round(value * 3.6)} km/h`; // Convert m/s → km/h
  return `${Math.round(parseFloat(value))}`;
};

const SegmentAttributesTable = ({ propertiesList, selectedGraph }) => {
  if (!propertiesList || propertiesList.length === 0) return null;

  const top = propertiesList[0];
  const showId = propertiesList.length > 1;

  const format = (value, isSpeed = false) => {
    if (value === undefined || value === null || isNaN(value)) return "-";
    if (isSpeed) return `${Math.round(value * 3.6)} km/h`;
    return `${Math.round(parseFloat(value))}`;
  };

  const renderPerFeatureValues = (key, unit = "") =>
    propertiesList.map((prop) => (
      <div key={prop.id} style={{ marginBottom: "0.25rem" }}>
        {format(prop[key])}{unit}
        {showId && <span style={{ color: "#888" }}> (ID: {prop.id})</span>}
      </div>
    ));

  return (
    <div className="canton-mode-share">
      <h4>Segment Info</h4>
      <table>
        <tbody>
          <tr>
            <td><strong>Length</strong></td>
            <td>{format(top.length)} m</td>
          </tr>
          <tr>
            <td><strong>Free Speed</strong></td>
            <td>{format(top.freespeed, true)}</td>
          </tr>
          <tr>
            <td><strong>Capacity</strong></td>
            <td>{renderPerFeatureValues("capacity")}</td>
          </tr>
          <tr>
            <td><strong>Lanes</strong></td>
            <td>{renderPerFeatureValues("permlanes")}</td>
          </tr>
          {selectedGraph === "Volumes" && (
            <tr>
              <td><strong>Avg Daily Volume</strong></td>
              <td>{renderPerFeatureValues("daily_avg_volume", " vehicles/day")}</td>
            </tr>
          )}
          <tr>
            <td><strong>Modes</strong></td>
            <td>
              <div className="mode-badges">
                {top.modes?.split(",").map((mode) => (
                  <span className="mode-badge" key={mode}>{mode}</span>
                ))}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default SegmentAttributesTable;