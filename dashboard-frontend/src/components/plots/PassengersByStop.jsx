import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import {
  useTransitDatasets,
  useCantonCountsPerDataset,
  useStopAlignment,
  resolveLineId,
  getLineNameFromStop,
  filterCountRows,
} from "../../hooks/useTransitComparison";
import PlotLoader from "./PlotLoader";
import cantonAlias from "../../utils/canton_alias.json";

const METRICS = {
  boardings: { label: "Boardings", color: "#1f77b4" },
  alightings: { label: "Alightings", color: "#ff7f0e" },
};

// 24 hourly bins. The v2 backend emits hourly "HH:00" time_bins; legacy CDN
// data is 15-minute — either way we aggregate by hour so every bin has data
// and bargap:0 renders a continuous histogram silhouette (laying out 96
// 15-min slots against hourly data left 3 of 4 bars empty → spiky gaps).
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

const PassengersByStop = ({ sidebarCollapsed, isExpanded = false, metric = "boardings" }) => {
  const { selectedCanton, selectedTransitStop, selectedTransitLine } = useDashboard();

  const { label, color } = METRICS[metric] || METRICS.boardings;

  useResizeOnSidebarChange(sidebarCollapsed);

  const datasets = useTransitDatasets();
  const isComparison = datasets.length > 1;
  const countsPerDataset = useCantonCountsPerDataset(selectedCanton);
  const { resolveStopIds } = useStopAlignment(selectedCanton);

  // One hourly series per dataset. In single mode this reduces to exactly
  // the legacy pipeline (cleaned stop ids + line id filter, no alignment).
  const perDataset = useMemo(() => {
    return countsPerDataset.map(({ dataset, rows }) => {
      if (!rows) return { dataset, values: null, unmatched: false };

      const stopIds = selectedTransitStop?.stop_ids
        ? resolveStopIds(dataset, selectedTransitStop)
        : undefined;
      let lineId = selectedTransitLine ?? null;
      if (lineId != null && !dataset.isPrimary) {
        lineId = resolveLineId(rows, lineId, getLineNameFromStop(selectedTransitStop, lineId));
      }

      const filtered = filterCountRows(rows, { stopIds, lineId });
      const grouped = {};
      for (const row of filtered) {
        for (const t of row.data) {
          const hour = `${String(t.time_bin).slice(0, 2)}:00`;
          grouped[hour] = (grouped[hour] ?? 0) + (t[metric] ?? 0);
        }
      }
      return {
        dataset,
        values: HOUR_LABELS.map((t) => grouped[t] ?? 0),
        unmatched: stopIds === null,
      };
    });
  }, [countsPerDataset, resolveStopIds, selectedTransitStop, selectedTransitLine, metric]);

  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific canton</div>;
  }

  if (!perDataset.some((d) => d.values)) {
    return <PlotLoader />;
  }

  // Build title
  let plotTitle = `Hourly ${label} - ${cantonAlias[selectedCanton] || selectedCanton}`;
  if (selectedTransitStop) {
    plotTitle = `Hourly ${label} - ${selectedTransitStop.name}`;
    if (selectedTransitLine) {
      const lineName =
        getLineNameFromStop(selectedTransitStop, selectedTransitLine) || selectedTransitLine;
      plotTitle += ` (${lineName})`;
    }
  }

  const traces = perDataset
    .filter((d) => d.values)
    .map(({ dataset, values, unmatched }) => ({
      type: "bar",
      x: HOUR_LABELS,
      y: values,
      marker: { color: isComparison ? dataset.color : color },
      // Overlaid, gapless, semi-transparent bars read as a filled
      // distribution silhouette — matches the Activity Duration / Departure
      // Times histograms (barmode overlay, bargap 0, opacity 0.6).
      opacity: isComparison ? 0.55 : 0.6,
      name: isComparison
        ? unmatched
          ? `${dataset.name} (stop not matched)`
          : dataset.name
        : label,
      hovertemplate: isComparison
        ? `<b>%{x}</b><br>${label}: %{y}<extra>%{fullData.name}</extra>`
        : `<b>%{x}</b><br>${label}: %{y}<extra></extra>`,
    }));

  const layout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 5, b: 50 },
    xaxis: {
      // Force categorical treatment — otherwise Plotly auto-types the "HH:MM"
      // strings as a time axis and places fixed-width bars with gaps that
      // bargap can't close. category + bargap 0 = seamless silhouette.
      type: "category",
      title: { text: "Time of Day", font: { size: 11 } },
      tickangle: -45,
      tickfont: { size: 9 },
    },
    yaxis: {
      title: { text: "Passenger Count", font: { size: 11 } },
      tickfont: { size: 9 },
    },
    hovermode: "closest",
    barmode: "overlay",
    bargap: 0,
    showlegend: isComparison,
    ...(isComparison && {
      legend: { orientation: "h", y: 1.05, x: 0.5, xanchor: "center", font: { size: 10 } },
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
      filename: `${selectedCanton}_hourly_${metric}`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{plotTitle}</h4>
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

export default PassengersByStop;
