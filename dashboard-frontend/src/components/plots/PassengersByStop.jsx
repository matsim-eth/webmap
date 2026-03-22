import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useQuery } from "@tanstack/react-query";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import cantonAlias from "../../utils/canton_alias.json";

const METRICS = {
  boardings: { label: "Boardings", color: "#1f77b4" },
  alightings: { label: "Alightings", color: "#ff7f0e" },
};

const PassengersByStop = ({ sidebarCollapsed, isExpanded = false, metric = "boardings" }) => {
  const { selectedCanton, selectedTransitStop, selectedTransitLine } = useDashboard();
  const { getCantonData } = useData();

  const { label, color } = METRICS[metric] || METRICS.boardings;

  useResizeOnSidebarChange(sidebarCollapsed);

  const { data: rawData = null } = useQuery({
    queryKey: ['cantonCounts', selectedCanton],
    queryFn: () =>
      getCantonData(`matsim/transit/per_canton_counts/${selectedCanton}_counts.json`)
        .catch(() => null),
    enabled: !!selectedCanton && selectedCanton !== "All",
  });

  const hourlyCounts = useMemo(() => {
    if (!rawData) return null;

    let filteredData = rawData;
    if (selectedTransitStop && selectedTransitStop.stop_ids) {
      const cleanedIds = selectedTransitStop.stop_ids.flatMap((s) => {
        if (Array.isArray(s)) return s;
        try {
          return JSON.parse(s);
        } catch {
          return String(s).split(",").map((id) => id.trim());
        }
      });
      filteredData = rawData.filter((d) => cleanedIds.includes(String(d.stop_id)));
    }

    if (selectedTransitLine) {
      filteredData = filteredData.filter(
        (d) => String(d.line_id) === String(selectedTransitLine)
      );
    }

    // Aggregate by time bin
    const grouped = {};
    for (const row of filteredData) {
      for (const t of row.data) {
        if (!grouped[t.time_bin]) grouped[t.time_bin] = 0;
        grouped[t.time_bin] += t[metric] ?? 0;
      }
    }

    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
  }, [rawData, selectedTransitStop, selectedTransitLine, metric]);

  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific canton</div>;
  }

  if (!hourlyCounts) {
    return <div className="plot-loading">Loading...</div>;
  }

  // Generate full 15-minute interval labels
  const fullLabels = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      fullLabels.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }

  const dataMap = Object.fromEntries(hourlyCounts);
  const paddedValues = fullLabels.map((t) => dataMap[t] ?? 0);

  // Build title
  let plotTitle = `Hourly ${label} - ${cantonAlias[selectedCanton] || selectedCanton}`;
  if (selectedTransitStop) {
    plotTitle = `Hourly ${label} - ${selectedTransitStop.name}`;
    if (selectedTransitLine) {
      let linesArray = selectedTransitStop.lines;
      if (typeof linesArray === "string") {
        try { linesArray = JSON.parse(linesArray); } catch { linesArray = []; }
      }
      const lineObj = Array.isArray(linesArray)
        ? linesArray.find((l) => String(l.line_id) === String(selectedTransitLine))
        : null;
      const lineName = lineObj?.line_name || lineObj?.lineName || lineObj?.name || selectedTransitLine;
      plotTitle += ` (${lineName})`;
    }
  }

  const trace = {
    type: "bar",
    x: fullLabels,
    y: paddedValues,
    marker: { color },
    name: label,
    hovertemplate: `<b>%{x}</b><br>${label}: %{y}<extra></extra>`,
  };

  const layout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 5, b: 50 },
    xaxis: {
      title: { text: "Time of Day", font: { size: 11 } },
      tickangle: -45,
      tickfont: { size: 8 },
    },
    yaxis: {
      title: { text: "Passenger Count", font: { size: 11 } },
      tickfont: { size: 9 },
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
        data={[trace]}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler={true}
      />
    </div>
  );
};

export default PassengersByStop;
