import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const HOUR_TICKS = Array.from({ length: 13 }, (_, i) => i * 120); // 0, 120, 240, ..., 1440
const HOUR_LABELS = HOUR_TICKS.map((m) => {
  const h = m / 60;
  return `${h.toString().padStart(2, "0")}:00`;
});

const SpeedByTime = ({
  sidebarCollapsed,
  isExpanded = false,
  metric = "avg_speed_kmh",
  title = "Average Speed by Time of Day",
  yAxisLabel = "Speed [km/h]",
  backendUrlTemplate,
  exportFilename = "speed-by-time",
}) => {
  useResizeOnSidebarChange(sidebarCollapsed);

  const { selectedRoadType } = useDashboard();
  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate);
  const syntheticSlots = useMemo(
    () => slotDatasets.filter((s) => s.subDataset === "Synthetic"),
    [slotDatasets]
  );

  const traces = useMemo(() => {
    if (!syntheticSlots.length) return [];
    const isFiltered = selectedRoadType && selectedRoadType !== "all";
    return syntheticSlots.map((slot) => {
      const rows = isFiltered
        ? (slot.rawPayload?.by_time_road_type ?? []).filter((r) => r.road_type === selectedRoadType)
        : slot.rawPayload?.by_time ?? [];
      const sorted = [...rows].sort((a, b) => (a.time_bin || 0) - (b.time_bin || 0));
      const x = sorted.map((r) => r.time_bin);
      const y = sorted.map((r) => {
        if (metric === "congestion_index" && r.congestion_index != null) {
          return r.congestion_index * 100;
        }
        return r[metric] ?? null;
      });
      return {
        type: "scatter",
        mode: "lines",
        name: slot.label,
        x,
        y,
        line: { color: slot.color, width: 2 },
      };
    });
  }, [syntheticSlots, metric, selectedRoadType]);

  if (isLoading || !slotDatasets?.length) return <PlotLoader />;
  if (!syntheticSlots.length) {
    return <div className="plot-loading">Speed data is synthetic-only. Add a synthetic slot.</div>;
  }
  if (!traces.some((t) => t.y.length)) return <div className="plot-loading">No data available</div>;

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">{title}</h4>
      <Plot
        data={traces}
        layout={{
          xaxis: {
            title: "Time of Day",
            tickfont: { size: 9 },
            titlefont: { size: 11 },
            range: [0, 1440],
            tickmode: "array",
            tickvals: HOUR_TICKS,
            ticktext: HOUR_LABELS,
          },
          yaxis: {
            title: { text: yAxisLabel, font: { size: 11 }, standoff: 5 },
            tickfont: { size: 9 },
            rangemode: "tozero",
          },
          margin: { l: 55, r: 15, t: 5, b: 55 },
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

export default SpeedByTime;
