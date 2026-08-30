import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import {
  useTransitDatasets,
  useTransferDataPerDataset,
  useStopAlignment,
  candidateStopIdsForDataset,
  matchTransferParts,
} from "../../hooks/useTransitComparison";
import PlotLoader from "./PlotLoader";

// Merge every matched platform record's outbound stop-transfers into one map.
const mergeDestinations = (parts) => {
  const stopTransfers = {};
  let totalOut = 0;
  for (const part of parts) {
    totalOut += part?.total_transfers_out || 0;
    for (const [sid, c] of Object.entries(part?.stop_transfers || {})) {
      stopTransfers[sid] = (stopTransfers[sid] || 0) + c;
    }
  }
  const walkingTotal = Object.values(stopTransfers).reduce((s, c) => s + c, 0);
  return { stopTransfers, sameStop: totalOut - walkingTotal };
};

const SINGLE_DEST_COLOR = "#f97316";
const SINGLE_SELF_COLOR = "#3b82f6";

const TransferDestinations = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedCanton, selectedTransitStop, datasetId, zoneLabel } = useDashboard();
  const { getCantonData } = useData();

  const datasets = useTransitDatasets();
  const isComparison = datasets.length > 1;
  const transferPerDataset = useTransferDataPerDataset();
  const { resolveStopIds } = useStopAlignment(selectedCanton);

  useResizeOnSidebarChange(sidebarCollapsed);

  // Destination stop ids → names. Same-scenario stops share ids across runs,
  // so the primary canton's geojson resolves both datasets' destinations.
  const { data: stopsData = null } = useQuery({
    queryKey: ["cantonStops", datasetId, selectedCanton],
    queryFn: () =>
      getCantonData(`matsim/transit/stops_by_canton/${encodeURIComponent(selectedCanton)}_stops.geojson`)
        .then((geojson) => geojson?.features || [])
        .catch(() => null),
    enabled: !!selectedCanton && selectedCanton !== "All",
  });

  // Transfer destinations often sit in neighbouring cantons (the transfer file
  // merges the selected canton + the inter_cantonal bucket), and those names
  // don't exist in the single-canton geojson above — which is why some bars
  // showed a raw id. inter_cantonal_stops is the all-canton superset, so it
  // resolves every destination. Shared query cache with useEffectiveLineCantons.
  const { data: interStops = null } = useQuery({
    queryKey: ["interCantonalStops", datasetId],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      getCantonData("matsim/transit/stops_by_canton/inter_cantonal_stops.geojson")
        .then((geojson) => geojson?.features || [])
        .catch(() => null),
  });

  const stopIdToName = useMemo(() => {
    const features = [...(stopsData || []), ...(interStops || [])];
    if (features.length === 0) return {};
    const lookup = {};
    for (const feature of features) {
      const name = feature.properties?.name;
      let stopIds = feature.properties?.stop_id;
      if (!name || !stopIds) continue;
      if (typeof stopIds === "string") {
        try { stopIds = JSON.parse(stopIds); } catch { stopIds = [stopIds]; }
      }
      if (!Array.isArray(stopIds)) stopIds = [stopIds];
      for (const sid of stopIds) {
        lookup[sid] = name;
        const baseMatch = String(sid).match(/^(\d+)/);
        if (baseMatch) lookup[baseMatch[1]] = name;
      }
    }
    return lookup;
  }, [stopsData, interStops]);

  const anyTransfer = transferPerDataset.some((d) => d.data);

  const result = useMemo(() => {
    if (!selectedTransitStop || !anyTransfer || !selectedCanton) return null;

    const resolveStopName = (rawId) => {
      if (stopIdToName[rawId]) return stopIdToName[rawId];
      const baseMatch = String(rawId).match(/^(\d+)/);
      if (baseMatch && stopIdToName[baseMatch[1]]) return stopIdToName[baseMatch[1]];
      return rawId.length > 20 ? rawId.slice(0, 18) + "..." : rawId;
    };

    // Per dataset: outbound transfers aggregated by destination *name*
    // (name-join makes the two runs line up even if some ids differ).
    const selfName = selectedTransitStop.name;
    const perDataset = transferPerDataset.map(({ dataset, data }) => {
      const candidateIds = candidateStopIdsForDataset(dataset, selectedTransitStop, resolveStopIds);
      const parts = matchTransferParts(data, selectedCanton, candidateIds);
      const { stopTransfers, sameStop } = mergeDestinations(parts);
      const byName = {};
      for (const [sid, c] of Object.entries(stopTransfers)) {
        const name = resolveStopName(sid);
        byName[name] = (byName[name] || 0) + c;
      }
      if (sameStop > 0) byName[selfName] = (byName[selfName] || 0) + sameStop;
      return { dataset, matched: parts.length, byName };
    });

    // Combined ranking across datasets → top 8 destination names.
    const combined = {};
    for (const d of perDataset) {
      for (const [name, c] of Object.entries(d.byName)) {
        combined[name] = (combined[name] || 0) + c;
      }
    }
    const names = Object.entries(combined)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([name]) => name);

    if (names.length === 0) return null;

    return { names, perDataset, selfName };
  }, [selectedTransitStop, anyTransfer, transferPerDataset, selectedCanton, resolveStopIds, stopIdToName]);

  // --- Render states ---
  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific {zoneLabel.toLowerCase()}</div>;
  }
  if (!anyTransfer) {
    return <PlotLoader />;
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
  if (!result) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <h4 className="plot-title">Top Transfer Destinations (Outbound Trips) - {selectedTransitStop.name}</h4>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          No transfer destination data<br />available for this stop
        </div>
      </div>
    );
  }

  const { names, perDataset, selfName } = result;

  const traces = isComparison
    ? perDataset.map(({ dataset, byName }) => ({
        type: "bar",
        name: dataset.name,
        x: names,
        y: names.map((n) => byName[n] || 0),
        marker: { color: dataset.color },
        hovertemplate: "<b>%{x}</b><br>Transfers: %{y}<extra>%{fullData.name}</extra>",
      }))
    : [
        {
          type: "bar",
          x: names,
          y: names.map((n) => perDataset[0].byName[n] || 0),
          // Self-stop (within-station) bar in blue, walking destinations orange.
          marker: { color: names.map((n) => (n === selfName ? SINGLE_SELF_COLOR : SINGLE_DEST_COLOR)) },
          hovertemplate: "<b>%{x}</b><br>Transfers: %{y}<extra></extra>",
        },
      ];

  const matchedNote = perDataset
    .filter((d) => isComparison && d.matched === 0)
    .map((d) => d.dataset.name);

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
    showlegend: isComparison,
    ...(isComparison && {
      barmode: "group",
      legend: { orientation: "h", y: 1.02, x: 0.5, xanchor: "center", yanchor: "bottom", font: { size: 9 } },
    }),
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
  };

  const config = {
    responsive: true,
    displayModeBar: isExpanded ? "hover" : false,
    displaylogo: false,
    toImageButtonOptions: {
      format: "png",
      filename: `${selectedCanton}_transfer_destinations${isComparison ? "_compare" : ""}`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">Top Transfer Destinations (Outbound Trips) - {selectedTransitStop.name}</h4>
      {matchedNote.length > 0 && (
        <div style={{ fontSize: "10px", color: "#b45309", marginBottom: "2px" }}>
          Stop not matched (by id or name) in: {matchedNote.join(", ")}
        </div>
      )}
      <Plot
        data={traces}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler={true}
      />
    </div>
  );
};

export default TransferDestinations;
