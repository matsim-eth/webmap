import React, { useState } from "react";
import "./Table.css";

const TransitStopAttributesTable = ({ properties, onLineClick, highlightedLineId, onRouteHover }) => {
  if (!properties) return null;
  
  const { name, modes_list, stop_id, lines } = properties;
  
  const [hoveredRoute, setHoveredRoute] = useState(null);
  const [showRoutes, setShowRoutes] = useState(false); 
  
  const groupedLines = lines.reduce((acc, line) => {
    if (!acc[line.line_id]) acc[line.line_id] = [];
    acc[line.line_id].push(line);
    return acc;
  }, {});
  
  const numRoutes = lines?.length || 0;
  const numLines = Object.keys(groupedLines).length;
  
  const activeBadge = highlightedLineId;
  
  const handleBadgeClick = (line_id) => {
    const isActive = highlightedLineId === line_id;
    const routeIds = groupedLines[line_id].map(route => route.route_id);
    
    if (onLineClick) {
      onLineClick(isActive ? null : line_id, isActive ? [] : routeIds);
    }
  };
  
  return (
    <div className="canton-mode-share">
    <h4>{name}</h4>
    <table>
    <tbody>
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
      className={`mode-badge ${activeBadge === lineId ? "active" : ""}`}
      onClick={() => handleBadgeClick(lineId)}
      >
      {routes[0].line_name || lineId} ({routes[0].mode})
      </span>
    ))}
    </div>
    
    {/* Toggle button to show/hide routes */}
    {activeBadge && (
      <div
      onClick={() => setShowRoutes(!showRoutes)}
      style={{
        fontWeight: "bold",
        fontSize: "10pt",
        marginTop: "0.5rem",
        cursor: "pointer",
        userSelect: "none",
        color: "#333"
      }}
      >
      {showRoutes ? "Hide Routes" : "Show Routes"}
      </div>
    )}
    
    {/* Conditional route list */}
    {showRoutes && activeBadge && Array.isArray(groupedLines[activeBadge]) && (
      <ul className="route-list">
      {groupedLines[activeBadge].map((route, i) => (
        <li
        key={i}
        onMouseEnter={() => {
          setHoveredRoute(route.route_id);
          onRouteHover?.(route.route_id);
        }}
        onMouseLeave={() => {
          setHoveredRoute(null);
          onRouteHover?.(null);
        }}
        style={{
          fontWeight: hoveredRoute === route.route_id ? "bold" : "normal",
          cursor: "pointer"
        }}
        >
        {route.route_id}
        </li>
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
