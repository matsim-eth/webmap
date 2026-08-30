import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const SpeedByRoadType = ({
  sidebarCollapsed,
  isExpanded = false,
  backendUrlTemplate,
  exportFilename = "speed-by-road-type",
}) => {
  useResizeOnSidebarChange(sidebarCollapsed);

  const { selectedRoadType } = useDashboard();
  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate);
  const syntheticSlots = useMemo(
    () => slotDatasets.filter((s) => s.subDataset === "Synthetic"),
    [slotDatasets]
  );

  const { traces, categories } = useMemo(() => {
    if (isLoading || !syntheticSlots.length) return { traces: [], categories: [] };

    const applyFilter = (rows) =>
      selectedRoadType && selectedRoadType !== "all"
        ? rows.filter((r) => r.road_type === selectedRoadType)
        : rows;

    // Collect road types across all slots, ordered by volume in the first slot
    const firstRows = applyFilter(syntheticSlots[0].rawPayload?.by_road_type ?? []);
    const ordered = [...firstRows]
      .sort((a, b) => (b.total_volume || 0) - (a.total_volume || 0))
      .map((r) => r.road_type);

    // Include any extra road types from other slots
    const seen = new Set(ordered);
    syntheticSlots.slice(1).forEach((slot) => {
      applyFilter(slot.rawPayload?.by_road_type ?? []).forEach((r) => {
        if (!seen.has(r.road_type)) {
          ordered.push(r.road_type);
          seen.add(r.road_type);
        }
      });
    });

    const slotMaps = syntheticSlots.map((slot) => ({
      slot,
      byType: new Map(
        applyFilter(slot.rawPayload?.by_road_type ?? []).map((r) => [r.road_type, r])
      ),
    }));

    const avgTraces = slotMaps.map(({ slot, byType }) => {
      const avg = ordered.map((t) => byType.get(t)?.avg_speed_kmh ?? null);
      return {
        type: "bar",
        name: `${slot.label} — Avg`,
        x: ordered,
        y: avg,
        marker: { color: slot.color },
        text: avg.map((v) => (v == null ? "" : v.toFixed(1))),
        textposition: "auto",
      };
    });

    const freeTraces = slotMaps.map(({ slot, byType }) => {
      const free = ordered.map((t) => byType.get(t)?.freespeed_kmh ?? null);
      return {
        type: "bar",
        name: `${slot.label} — Freespeed`,
        x: ordered,
        y: free,
        marker: { color: slot.color, opacity: 0.45, pattern: { shape: "/" } },
        text: free.map((v) => (v == null ? "" : v.toFixed(1))),
        textposition: "auto",
      };
    });

    const slotTraces = [...avgTraces, ...freeTraces];

    return { traces: slotTraces, categories: ordered };
  }, [syntheticSlots, isLoading, selectedRoadType]);

  if (isLoading || !slotDatasets?.length) return <PlotLoader />;
  if (!syntheticSlots.length) {
    return <div className="plot-loading">Speed data is synthetic-only. Add a synthetic slot.</div>;
  }
  if (!categories.length) return <div className="plot-loading">No data available</div>;

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">Speed by Road Type</h4>
      <Plot
        data={traces}
        layout={{
          xaxis: {
            title: "Road Type",
            type: "category",
            tickangle: -45,
            tickfont: { size: 9 },
            titlefont: { size: 11 },
          },
          yaxis: {
            title: { text: "Speed [km/h]", font: { size: 11 }, standoff: 5 },
            tickfont: { size: 9 },
          },
          barmode: "group",
          margin: { l: 50, r: 15, t: 5, b: 70 },
          legend: { orientation: "h", y: 1.08, font: { size: 9 } },
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          autosize: true,
        }}
        useResizeHandler={true}
        style={{ width: "100%", height: "100%" }}
        config={{
          responsive: true,
          displayModeBar: isExpanded ? "hover" : false,
          toImageButtonOptions: {
            filename: exportFilename,
            format: "png",
            height: 800,
            width: 1200,
          },
        }}
      />
    </div>
  );
};

export default SpeedByRoadType;
