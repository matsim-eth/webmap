import React, { useEffect, useState, useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const TransferDestinations = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedCanton, selectedTransitStop } = useDashboard();
  const [transferData, setTransferData] = useState(null);
  const [stopsData, setStopsData] = useState(null);
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
      setStopsData(null);
      return;
    }

    Promise.all([
      loadWithFallback("stop_transfer_data_by_canton.json"),
      loadWithFallback(`matsim/transit/stops_by_canton/${selectedCanton}_stops.geojson`),
    ])
      .then(([tData, geojson]) => {
        setTransferData(tData);
        setStopsData(geojson?.features || []);
      })
      .catch((err) => {
        console.error("Error loading transfer destinations data:", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCanton]);

  // Build a lookup from stop ID fragments to stop names
  const stopIdToName = useMemo(() => {
    if (!stopsData) return {};
    const lookup = {};
    for (const feature of stopsData) {
      const name = feature.properties?.name;
      let stopIds = feature.properties?.stop_id;
      if (!name || !stopIds) continue;

      if (typeof stopIds === "string") {
        try { stopIds = JSON.parse(stopIds); } catch { stopIds = [stopIds]; }
      }
      if (!Array.isArray(stopIds)) stopIds = [stopIds];

      for (const sid of stopIds) {
        // Store the full ID
        lookup[sid] = name;
        // Also store the base numeric part (e.g. "8508391" from "8508391.link:pt_8508391")
        const baseMatch = String(sid).match(/^(\d+)/);
        if (baseMatch) {
          lookup[baseMatch[1]] = name;
        }
      }
    }
    return lookup;
  }, [stopsData]);

  const resolveStopName = (rawId) => {
    // Direct match
    if (stopIdToName[rawId]) return stopIdToName[rawId];

    // Try extracting the base numeric ID from the transfer data key
    // e.g. "8508391:0:1.link:pt_8508391:0:1" -> "8508391"
    const baseMatch = String(rawId).match(/^(\d+)/);
    if (baseMatch && stopIdToName[baseMatch[1]]) {
      return stopIdToName[baseMatch[1]];
    }

    // Fallback: truncated ID
    return rawId.length > 20 ? rawId.slice(0, 18) + "..." : rawId;
  };

  const destinationResult = useMemo(() => {
    if (!selectedTransitStop || !transferData || !selectedCanton) return null;

    // Merge selected canton + inter_cantonal
    const cantonData = {
      ...(transferData[selectedCanton] || {}),
      ...(transferData["inter_cantonal"] || {}),
    };

    if (Object.keys(cantonData).length === 0) return null;

    // Find stop data (same matching logic as other transit plots)
    let foundStopData = null;

    const primaryStopId = selectedTransitStop.stop_id;
    if (primaryStopId && cantonData[primaryStopId]) {
      foundStopData = cantonData[primaryStopId];
    }

    if (!foundStopData && selectedTransitStop.stop_ids) {
      const cleanedIds = selectedTransitStop.stop_ids.flatMap((s) => {
        if (Array.isArray(s)) return s;
        try { return JSON.parse(s); } catch { return String(s).split(",").map((id) => id.trim()); }
      });

      for (const altId of cleanedIds) {
        if (cantonData[altId]) { foundStopData = cantonData[altId]; break; }
      }

      if (!foundStopData) {
        for (const stopId of cleanedIds) {
          if (!stopId) continue;
          const matchKey = Object.keys(cantonData).find(
            (key) => key.includes(stopId) || stopId.includes(key.split(":")[0] + ":")
          );
          if (matchKey) { foundStopData = cantonData[matchKey]; break; }
        }
      }
    }

    if (!foundStopData) return null;

    const stopTransfers = foundStopData.stop_transfers || {};
    const totalOut = foundStopData.total_transfers_out || 0;
    const walkingTotal = Object.values(stopTransfers).reduce((sum, c) => sum + c, 0);
    const sameStopTransfers = totalOut - walkingTotal;

    const topDestinations = Object.entries(stopTransfers)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 7); // 7 to leave room for self-stop bar

    if (topDestinations.length === 0 && sameStopTransfers <= 0) return null;

    return {
      topDestinations,
      sameStopTransfers,
    };
  }, [selectedTransitStop, transferData, selectedCanton]);

  // --- Render states ---
  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific canton</div>;
  }

  if (!transferData) {
    return <div className="plot-loading">Loading...</div>;
  }

  if (!selectedTransitStop) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          Select a transit stop to view<br />transfer destinations
        </div>
      </div>
    );
  }

  if (!destinationResult) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <h4 className="plot-title">Transfer Destinations (Outbound Trips) - {selectedTransitStop.name}</h4>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          No transfer destination data<br />available for this stop
        </div>
      </div>
    );
  }

  const { topDestinations, sameStopTransfers } = destinationResult;

  // Build entries: walking destinations + optional same-stop bar
  const entries = topDestinations.map(([stopId, count]) => ({
    name: resolveStopName(stopId),
    count,
    color: "#f97316",
  }));

  if (sameStopTransfers > 0) {
    entries.push({
      name: selectedTransitStop.name,
      count: sameStopTransfers,
      color: "#3b82f6",
    });
  }

  entries.sort((a, b) => b.count - a.count);

  const names = entries.map((e) => e.name);
  const counts = entries.map((e) => e.count);
  const colors = entries.map((e) => e.color);

  const trace = {
    type: "bar",
    x: names,
    y: counts,
    marker: {
      color: colors,
    },
    hovertemplate: "<b>%{x}</b><br>Transfers: %{y}<extra></extra>",
  };

  const layout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 5, b: 20 },
    xaxis: {
      title: { text: "Destination Stop", font: { size: 10, color: "#64748b" }, standoff: 5 },
      tickangle: -45,
      tickfont: { size: 8, color: "#475569" },
      automargin: true,
    },
    yaxis: {
      title: { text: "Transfer Count", font: { size: 10, color: "#64748b" } },
      tickfont: { size: 9, color: "#475569" },
      domain: [0.25, 1],
    },
    hovermode: "closest",
    showlegend: false,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
  };

  const config = {
    responsive: true,
    displayModeBar: isExpanded ? "hover" : false,
    displaylogo: false,
    toImageButtonOptions: {
      format: "png",
      filename: `${selectedCanton}_transfer_destinations`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">Top Transfer Destinations (Outbound Trips) - {selectedTransitStop.name}</h4>
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

export default TransferDestinations;
