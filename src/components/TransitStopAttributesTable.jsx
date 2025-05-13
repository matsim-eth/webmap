import React, { useState } from "react";
import "./Table.css";

const TransitStopAttributesTable = ({ properties, onLineClick, highlightedLineId }) => {
  if (!properties) return null;
  
  const { name, modes_list, stop_id, lines } = properties;
  
  const groupedLines = lines.reduce((acc, line) => {
    if (!acc[line.line_id]) acc[line.line_id] = [];
    acc[line.line_id].push(line);
    return acc;
  }, {});
  
  const numRoutes = lines?.length || 0;
  const numLines = Object.keys(groupedLines).length;
  
const handleBadgeClick = (line_id) => {
  const isActive = highlightedLineId === line_id;

  if (onLineClick) {
    if (isActive) {
      onLineClick(null, []);
    } else {
      const routeIds = groupedLines[line_id].map(route => route.route_id);
      onLineClick(line_id, routeIds);
    }
  }
};
  
  return (
    <div className="canton-mode-share">
    <h4>{name}</h4>
    <table>
    <tbody>
    <tr><td>Stop ID</td><td>{stop_id}</td></tr>
    <tr><td>Mode</td><td>{modes_list?.join(", ")}</td></tr>
    <tr><td>Lines</td><td>{numLines}</td></tr>
    <tr><td>Routes</td><td>{numRoutes}</td></tr>
    <tr>
    <td>Lines</td>
    <td>
    <div className="badge-container">
    {Object.entries(groupedLines).map(([lineId, routes], idx) => (
  <span
    key={idx}
    className={`mode-badge ${highlightedLineId === lineId ? "active" : ""}`}
    onClick={() => handleBadgeClick(lineId)}
  >
    {lineId} ({routes[0].mode})
  </span>
))}
    </div>
   {highlightedLineId && Array.isArray(groupedLines[highlightedLineId]) && (
  <ul className="route-list">
    {groupedLines[highlightedLineId].map((route, i) => (
      <li key={i}>{route.route_id}</li>
    ))}
  </ul>
)}
    
    </td>
    </tr>
    </tbody>
    </table>
    </div>
  );
};

export default TransitStopAttributesTable;
