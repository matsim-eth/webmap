import React, { useState } from "react";
import "../Table.css";

const DIRECTION_OPTIONS = [
  { value: 'total', label: 'Total' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'return', label: 'Return' }
];

const TransitStopAttributesTable = ({ properties, onLineClick, highlightedLineId, onRouteHover, selectedDirection, setSelectedDirection }) => {
  if (!properties) return null;
  
  const { name, modes_list, lines, boardings, alightings, total } = properties;
  
  const [hoveredRoute, setHoveredRoute] = useState(null);
  const [showRoutes, setShowRoutes] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  
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
    <div className="canton-mode-share" style={{ position: "relative" }}>
    <span
      role="button"
      tabIndex={0}
      onClick={() => setIsCollapsed(v => !v)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsCollapsed(v => !v); }}
      aria-label={isCollapsed ? "Expand" : "Collapse"}
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        cursor: "pointer",
        fontSize: 18,
        lineHeight: 1,
        userSelect: "none",
        color: "var(--color-text-secondary)",
      }}
    >
      {isCollapsed ? "+" : "−"}
    </span>
    <h4>{name}</h4>
    {!isCollapsed && (
    <table>
    <tbody>
    <tr><td>Mode</td><td>{modes_list?.join(", ")}</td></tr>
    <tr><td>Lines</td><td>{numLines}</td></tr>
    <tr><td>Routes</td><td>{numRoutes}</td></tr>
    <tr><td>Volumes</td><td>    
    <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
    <div className="metric-card">
    <div className="metric-label">Boardings</div>
    <div className="metric-value">{boardings}</div>
    </div>
    <div className="metric-card">
    <div className="metric-label">Alightings</div>
    <div className="metric-value">{alightings}</div>
    </div>
    <div className="metric-card">
    <div className="metric-label">Total Volume</div>
    <div className="metric-value">{total}</div>
    </div>
    </div></td></tr>
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
      <button
        type="button"
        className={`route-toggle ${showRoutes ? "is-open" : ""}`}
        onClick={() => setShowRoutes(!showRoutes)}
      >
        <span className="route-toggle-chevron" aria-hidden="true">▸</span>
        {showRoutes ? "Hide routes" : "Show routes"}
        <span className="route-toggle-count">{groupedLines[activeBadge]?.length ?? 0}</span>
      </button>
    )}

    {/* Conditional route list */}
    {showRoutes && activeBadge && Array.isArray(groupedLines[activeBadge]) && (
      <ul className="route-list">
        {groupedLines[activeBadge].map((route, i) => (
          <li
            key={i}
            className={`route-row ${hoveredRoute === route.route_id ? "is-hovered" : ""}`}
            onMouseEnter={() => {
              setHoveredRoute(route.route_id);
              onRouteHover?.(route.route_id);
            }}
            onMouseLeave={() => {
              setHoveredRoute(null);
              onRouteHover?.(null);
            }}
          >
            <span className="route-row-dot" aria-hidden="true" />
            <span className="route-row-id">{route.route_id}</span>
          </li>
        ))}
      </ul>
    )}
    </td>
    </tr>
    {/* <tr>
    <td>Direction</td>
    <td>
    <div style={{ display: 'flex' }}>
      {DIRECTION_OPTIONS.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => setSelectedDirection(opt.value)}
          style={{
            padding: '4px 10px',
            fontSize: '12px',
            border: '1px solid #ccc',
            borderLeft: i === 0 ? '1px solid #ccc' : 'none',
            borderRadius: i === 0 ? '4px 0 0 4px' : i === DIRECTION_OPTIONS.length - 1 ? '0 4px 4px 0' : '0',
            backgroundColor: selectedDirection === opt.value ? 'var(--color-primary, #6366f1)' : '#fff',
            color: selectedDirection === opt.value ? '#fff' : '#333',
            cursor: 'pointer'
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
    </td>
    </tr> */}
    </tbody>
    </table>
    )}
    </div>
  );
};

export default TransitStopAttributesTable;
