import React, { useEffect, useState, useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const TransferMatrix = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedCanton, selectedTransitStop } = useDashboard();
  const [transferData, setTransferData] = useState(null);
  const [boardingData, setBoardingData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 100);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!selectedCanton || selectedCanton === "All") {
      setTransferData(null);
      setBoardingData(null);
      return;
    }

    Promise.all([
      loadWithFallback("stop_transfer_data_by_canton.json"),
      loadWithFallback("boarding_data_by_line.json"),
    ])
      .then(([tData, bData]) => {
        setTransferData(tData);
        setBoardingData(bData);
      })
      .catch((err) => {
        console.error("Error loading transfer data:", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCanton]);

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

    // Find the stop data using multiple ID matching strategies
    let foundStopData = null;

    const primaryStopId = selectedTransitStop.stop_id;
    if (primaryStopId && cantonData[primaryStopId]) {
      foundStopData = cantonData[primaryStopId];
    }

    if (!foundStopData && selectedTransitStop.stop_ids) {
      const cleanedIds = selectedTransitStop.stop_ids.flatMap((s) => {
        if (Array.isArray(s)) return s;
        try {
          return JSON.parse(s);
        } catch {
          return String(s).split(",").map((id) => id.trim());
        }
      });

      for (const altId of cleanedIds) {
        if (cantonData[altId]) {
          foundStopData = cantonData[altId];
          break;
        }
      }

      // Partial match fallback
      if (!foundStopData) {
        for (const stopId of cleanedIds) {
          if (!stopId) continue;
          const matchKey = Object.keys(cantonData).find(
            (key) => key.includes(stopId) || stopId.includes(key.split(":")[0] + ":")
          );
          if (matchKey) {
            foundStopData = cantonData[matchKey];
            break;
          }
        }
      }
    }

    if (!foundStopData || !foundStopData.line_transfers) return null;

    const lineTransfers = foundStopData.line_transfers;
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

    // Resolve human-readable line names from boarding data
    const nameCount = {};
    lineArray.forEach((lineId) => {
      const entry = Object.values(boardingData).find((e) => e.line_id === lineId);
      let name = entry ? `${entry.line_name} (${entry.vehicle})` : lineId;
      nameCount[name] = (nameCount[name] || 0) + 1;
    });

    const nameUsed = {};
    lineArray.forEach((lineId) => {
      const entry = Object.values(boardingData).find((e) => e.line_id === lineId);
      let name = entry ? `${entry.line_name} (${entry.vehicle})` : lineId;
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
    return <div className="plot-loading">Loading...</div>;
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
