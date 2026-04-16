import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const ROAD_TYPE_COLORS = {
  motorway: "#e74c3c",
  trunk: "#e67e22",
  primary: "#f39c12",
  secondary: "#f1c40f",
  tertiary: "#27ae60",
  residential: "#3498db",
};

const ALLOWED_ROAD_TYPES = new Set(Object.keys(ROAD_TYPE_COLORS));

const HOUR_TICKS = Array.from({ length: 13 }, (_, i) => i * 120);
const HOUR_LABELS = HOUR_TICKS.map((m) => {
  const h = m / 60;
  return `${h.toString().padStart(2, "0")}:00`;
});

const SpeedByTimePerRoadType = ({
  sidebarCollapsed,
  isExpanded = false,
  backendUrlTemplate,
  exportFilename = "speed-by-time-per-road-type",
}) => {
  useResizeOnSidebarChange(sidebarCollapsed);

  const { selectedRoadType } = useDashboard();
  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate);
  const syntheticSlots = useMemo(
    () => slotDatasets.filter((s) => s.subDataset === "Synthetic"),
    [slotDatasets]
  );

  const traces = useMemo(() => {
    const multipleSlot = syntheticSlots.length > 1;
    const isFiltered = selectedRoadType && selectedRoadType !== "all";
    return syntheticSlots.flatMap((slot, slotIdx) => {
      const rows = slot.rawPayload?.by_time_road_type ?? [];
      const byRoadType = new Map();
      rows.forEach((r) => {
        if (!ALLOWED_ROAD_TYPES.has(r.road_type)) return;
        if (isFiltered && r.road_type !== selectedRoadType) return;
        if (!byRoadType.has(r.road_type)) byRoadType.set(r.road_type, []);
        byRoadType.get(r.road_type).push(r);
      });

      // Order road types by total volume for stable legend ordering
      const ordered = [...byRoadType.entries()].sort((a, b) => {
        const volA = a[1].reduce((s, r) => s + (r.total_volume || 0), 0);
        const volB = b[1].reduce((s, r) => s + (r.total_volume || 0), 0);
        return volB - volA;
      });

      return ordered.map(([rt, rs]) => {
        const sorted = [...rs].sort((a, b) => (a.time_bin || 0) - (b.time_bin || 0));
        return {
          type: "scatter",
          mode: "lines",
          name: multipleSlot ? `${slot.label} — ${rt}` : rt,
          x: sorted.map((r) => r.time_bin),
          y: sorted.map((r) => r.avg_speed_kmh ?? null),
          line: {
            color: ROAD_TYPE_COLORS[rt] || "#888",
            width: 2,
            dash: multipleSlot && slotIdx > 0 ? "dot" : "solid",
          },
        };
      });
    });
  }, [syntheticSlots, selectedRoadType]);

  if (isLoading || !slotDatasets?.length) return <PlotLoader />;
  if (!syntheticSlots.length) {
    return <div className="plot-loading">Speed data is synthetic-only. Add a synthetic slot.</div>;
  }
  if (!traces.length) return <div className="plot-loading">No data available</div>;

  return (
    <div className="plot-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">Average Speed by Time of Day — per Road Type</h4>
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
            title: { text: "Speed [km/h]", font: { size: 11 }, standoff: 5 },
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

export default SpeedByTimePerRoadType;
