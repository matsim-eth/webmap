import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import PlotLoader from "./PlotLoader";

const TransferMatrix = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedCanton, selectedTransitStop } = useDashboard();
  const { getData } = useData();

  const transferData = getData("stop_transfer_data_by_canton.json");
  const boardingData = getData("boarding_data_by_line.json");

  useResizeOnSidebarChange(sidebarCollapsed);

  const matrixResult = useMemo(() => {
    if (!selectedTransitStop || !transferData || !boardingData || !selectedCanton) {
      return null;
    }

  // Merge selected canton + inter_cantonal
  const cantonData = {
    ...(transferData[selectedCanton] || {}),
    ...(transferData["inter_cantonal"] || {}),
  };

  if (Object.keys(cantonData).length === 0) return null;

    // Collect EVERY platform entry of the selected station and merge them.
    // A station is many platform stop_ids, each with its own transfer record;
    // using only the first match showed one platform's transfers (e.g. 400)
    // next to the station-wide boarding totals (e.g. 4,800) on the same card.
    const candidateIds = [];
    if (selectedTransitStop.stop_id) {
      const p = selectedTransitStop.stop_id;
      candidateIds.push(...(Array.isArray(p) ? p : [p]));
    }
    if (selectedTransitStop.stop_ids) {
      candidateIds.push(...selectedTransitStop.stop_ids.flatMap((s) => {
        if (Array.isArray(s)) return s;
        try {
          return JSON.parse(s);
        } catch {
          return String(s).split(",").map((id) => id.trim());
        }
      }));
    }

    let matchedKeys = [...new Set(candidateIds.filter((id) => id && cantonData[id]))];

    // Partial match fallback (only when nothing matched exactly)
    if (matchedKeys.length === 0) {
      const keys = Object.keys(cantonData);
      matchedKeys = [...new Set(candidateIds.flatMap((stopId) =>
        stopId
          ? keys.filter((key) => key.includes(stopId) || stopId.includes(key.split(":")[0] + ":"))
          : []
      ))];
    }

    const parts = matchedKeys
      .map((k) => cantonData[k])
      .filter((d) => d && d.line_transfers);
    if (parts.length === 0) return null;

    // Merge: sum the from-line → to-line matrices and the in/out totals
    const lineTransfers = {};
    let totalIn = 0;
    let totalOut = 0;
    for (const part of parts) {
      totalIn += part.total_transfers_in || 0;
      totalOut += part.total_transfers_out || 0;
      for (const [fromLine, row] of Object.entries(part.line_transfers || {})) {
        const target = lineTransfers[fromLine] || (lineTransfers[fromLine] = {});
        for (const [toLine, n] of Object.entries(row)) {
          target[toLine] = (target[toLine] || 0) + n;
        }
      }
    }

    const allLines = new Set();

    Object.keys(lineTransfers).forEach((fromLine) => {
      allLines.add(fromLine);
      Object.keys(lineTransfers[fromLine]).forEach((toLine) => {
        allLines.add(toLine);
      });
    });

    if (allLines.size < 2) return null;

    const lineArray = Array.from(allLines).sort();
    const matrix = [];
    const lineNames = [];

    // Build lookup from stop's lines data (same source as the "Filter by Line" dropdown)
    const stopLinesMap = {};
    if (selectedTransitStop?.lines) {
      try {
        const linesArray = typeof selectedTransitStop.lines === 'string'
          ? JSON.parse(selectedTransitStop.lines)
          : selectedTransitStop.lines;
        if (Array.isArray(linesArray)) {
          linesArray.forEach((line) => {
            if (line.line_id && !stopLinesMap[line.line_id]) {
              const name = line.line_name || line.lineName || line.name;
              if (name) stopLinesMap[line.line_id] = { name, mode: line.mode };
            }
          });
        }
      } catch { /* ignore parse errors */ }
    }

    // Resolve line name: stop lines → boarding data → strip suffix fallback → raw ID
    const resolveName = (lineId) => {
      const stopLine = stopLinesMap[lineId];
      if (stopLine) {
        return stopLine.mode ? `${stopLine.name} (${stopLine.mode})` : stopLine.name;
      }
      const entry = Object.values(boardingData).find((e) => e.line_id === lineId);
      if (entry) return `${entry.line_name} (${entry.vehicle})`;
      return lineId;
    };

    const nameCount = {};
    lineArray.forEach((lineId) => {
      const name = resolveName(lineId);
      nameCount[name] = (nameCount[name] || 0) + 1;
    });

    const nameUsed = {};
    lineArray.forEach((lineId) => {
      let name = resolveName(lineId);
      if (nameCount[name] > 1) {
        nameUsed[name] = (nameUsed[name] || 0) + 1;
        name = `${name} #${nameUsed[name]}`;
      }
      lineNames.push(name);
    });

    lineArray.forEach((fromLine, i) => {
      const row = [];
      lineArray.forEach((toLine, j) => {
        row.push(i === j ? 0 : lineTransfers[fromLine]?.[toLine] || 0);
      });
      matrix.push(row);
    });

    return {
      matrix,
      lineNames,
      totalIn: foundStopData.total_transfers_in || 0,
      totalOut: foundStopData.total_transfers_out || 0,
    };
  }, [selectedTransitStop, transferData, boardingData, selectedCanton]);

  // --- Render states ---
  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific canton</div>;
  }

  if (!transferData || !boardingData) {
    return <PlotLoader />;
  }

  if (!selectedTransitStop) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          Select a transit stop to view<br />the transfer matrix
        </div>
      </div>
    );
  }

  if (!matrixResult) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <h4 className="plot-title">Transfer Matrix (Inbound Trips) - {selectedTransitStop.name}</h4>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          No transfer data available<br />for this stop
        </div>
      </div>
    );
  }

  const { matrix, lineNames, totalIn, totalOut } = matrixResult;

  // Find the midpoint of the data range for font color switching
  const allValues = matrix.flat().filter((v) => v > 0);
  const maxVal = allValues.length > 0 ? Math.max(...allValues) : 1;
  const midpoint = maxVal / 2;

  // Custom text for each cell (show value only if > 0)
  const textMatrix = matrix.map((row) =>
    row.map((val) => (val > 0 ? String(val) : ""))
  );

  // Per-cell font colors: white above midpoint, dark below
  const fontColorMatrix = matrix.map((row) =>
    row.map((val) => (val > midpoint ? "#ffffff" : "#1e293b"))
  );

  const trace = {
    z: matrix,
    x: lineNames,
    y: lineNames,
    text: textMatrix,
    texttemplate: "%{text}",
    textfont: { size: 10, color: fontColorMatrix },
    type: "heatmap",
    colorscale: [
      [0, "#f8fafc"],
      [0.2, "#dbeafe"],
      [0.4, "#93c5fd"],
      [0.6, "#3b82f6"],
      [0.8, "#1d4ed8"],
      [1, "#1e3a8a"],
    ],
    showscale: true,
    colorbar: {
      thickness: 12,
      len: 0.6,
      tickfont: { size: 9, color: "#64748b" },
      outlinewidth: 0,
    },
    hoverongaps: false,
    hovertemplate:
      "<b>From:</b> %{y}<br><b>To:</b> %{x}<br><b>Transfers:</b> %{z}<extra></extra>",
    xgap: 2,
    ygap: 2,
  };

  const layout = {
    autosize: true,
    margin: { l: 110, r: 60, t: 5, b: 90 },
    xaxis: {
      title: { text: "To Line", font: { size: 10, color: "#64748b" } },
      tickangle: -45,
      tickfont: { size: 8, color: "#475569" },
      side: "bottom",
    },
    yaxis: {
      title: { text: "From Line", font: { size: 10, color: "#64748b" } },
      tickfont: { size: 8, color: "#475569" },
      autorange: "reversed",
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
  };

  const config = {
    responsive: true,
    displayModeBar: isExpanded ? "hover" : false,
    displaylogo: false,
    toImageButtonOptions: {
      format: "png",
      filename: `${selectedCanton}_transfer_matrix`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">Transfer Matrix (Inbound Trips) - {selectedTransitStop.name}</h4>

      {/* Summary badges */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "4px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            color: "#1d4ed8",
            background: "#dbeafe",
            borderRadius: "12px",
            padding: "2px 8px",
          }}
        >
          In: {totalIn}
        </span>
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            color: "#c2410c",
            background: "#ffedd5",
            borderRadius: "12px",
            padding: "2px 8px",
          }}
        >
          Out: {totalOut}
        </span>
      </div>

      <Plot
        data={[trace]}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler={true}
      />
    </div>
  );
};

export default TransferMatrix;
