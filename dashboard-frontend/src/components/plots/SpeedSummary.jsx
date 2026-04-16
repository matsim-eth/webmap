import React from "react";
import { useDashboard } from "../../context/DashboardContext";
import { useComparisonData } from "../../hooks/useComparisonData";
import PlotLoader from "./PlotLoader";
import PlotLoadingOverlay from "./PlotLoadingOverlay";

const formatNum = (v, digits = 1) => {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const Stat = ({ label, value, unit }) => (
  <div className="speed-stat">
    <div className="speed-stat-value">
      {value}
      {unit && <span className="speed-stat-unit">{unit}</span>}
    </div>
    <div className="speed-stat-label">{label}</div>
  </div>
);

const SummaryRow = ({ label, data, highlight }) => {
  if (!data) return null;
  return (
    <div className={`speed-summary-row ${highlight ? "speed-summary-row-highlight" : ""}`}>
      <div className="speed-summary-row-label">{label}</div>
      <div className="speed-stats-grid">
        <Stat label="Avg Speed" value={formatNum(data.avg_speed_kmh, 1)} unit="km/h" />
        <Stat label="Freespeed" value={formatNum(data.freespeed_kmh, 1)} unit="km/h" />
        <Stat
          label="Congestion"
          value={data.congestion_index != null
            ? `${formatNum(data.congestion_index * 100, 0)}%`
            : "—"}
        />
        <Stat label="Links" value={formatNum(data.link_count ?? data.total_links, 0)} />
        <Stat label="Volume" value={formatNum(data.total_volume, 0)} />
      </div>
    </div>
  );
};

const SpeedSummary = ({ backendUrlTemplate }) => {
  const { selectedRoadType } = useDashboard();
  // Always fetch unfiltered so we can show overall + per-road-type rows
  const { slotDatasets, isLoading, isFetching } = useComparisonData(backendUrlTemplate);
  const syntheticSlots = slotDatasets.filter((s) => s.subDataset === "Synthetic");

  const isFiltered = selectedRoadType && selectedRoadType !== "all";

  if (isLoading || slotDatasets.length === 0) return <PlotLoader />;
  if (syntheticSlots.length === 0) {
    return <div className="plot-loading">Speed data is synthetic-only. Add a synthetic slot.</div>;
  }

  return (
    <div className="plot-wrapper speed-summary-wrapper">
      {isFetching && <PlotLoadingOverlay />}
      <h4 className="plot-title">Network Summary</h4>
      <div className="speed-summary-slots">
        {syntheticSlots.map((slot, i) => {
          const payload = slot.rawPayload;
          const summary = payload?.network_summary;
          const byRoadType = payload?.by_road_type ?? [];
          if (!summary) return null;

          // Visible rows: always "All Links"; then either all road types, or just the filtered one
          const visibleRoadTypes = isFiltered
            ? byRoadType.filter((r) => r.road_type === selectedRoadType)
            : byRoadType;

          return (
            <div key={i} className="speed-summary-slot">
              {syntheticSlots.length > 1 && (
                <div className="speed-summary-slot-header" style={{ borderColor: slot.color }}>
                  <span className="speed-summary-slot-dot" style={{ background: slot.color }} />
                  <span>{slot.label}</span>
                </div>
              )}
              <SummaryRow label="All Links" data={summary} />
              {visibleRoadTypes.map((r) => (
                <SummaryRow
                  key={r.road_type}
                  label={r.road_type}
                  data={r}
                  highlight={isFiltered && r.road_type === selectedRoadType}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SpeedSummary;
