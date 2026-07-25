import React from "react";

// Segmented Total / Outbound / Return control for the .H/.R route-direction
// filter. `labels` carries the per-direction terminus stop names (from
// useRouteDirections) — when known, the buttons read "Sursee" / "Baar"
// instead of the generic Outbound / Return; the map's terminus markers
// (useTransitLines) show the actual travel direction.
const DirectionToggle = ({ value, onChange, labels }) => {
  const options = [
    { value: "total", label: "Total" },
    { value: "outbound", label: labels?.outbound || "Outbound" },
    { value: "return", label: labels?.return || "Return" },
  ];
  return (
    <div style={{ display: "flex", flexWrap: "wrap" }}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          title={opt.label}
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            border: "1px solid #ccc",
            borderLeft: i === 0 ? "1px solid #ccc" : "none",
            borderRadius:
              i === 0 ? "4px 0 0 4px" : i === options.length - 1 ? "0 4px 4px 0" : "0",
            backgroundColor:
              value === opt.value ? "var(--color-primary, #6366f1)" : "#fff",
            color: value === opt.value ? "#fff" : "#333",
            cursor: "pointer",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
};

export default DirectionToggle;
