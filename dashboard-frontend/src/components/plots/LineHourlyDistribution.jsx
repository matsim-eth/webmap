import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { useDashboard } from '../../context/DashboardContext';
import { useResizeOnSidebarChange } from '../../hooks/useResizeOnSidebarChange';
import { useLineCantonCountsMulti } from '../../hooks/useTransitComparison';
import { lineMatchesFilter } from '../../utils/transitLineFilter';
import PlotLoader from './PlotLoader';

// 24 hourly bins. The v2 backend emits hourly "HH:00" time_bins; legacy CDN
// data is 15-minute — aggregating by hour keeps every bin populated so
// bargap:0 renders a continuous histogram silhouette instead of spiky
// quarter-hour gaps.
const TIME_LABELS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

const PLOT_CONFIG_BASE = {
  responsive: true,
  displaylogo: false,
};

// Diverging chart: boardings plot upward, alightings downward (negative y) so
// the two metrics never overlap. Hover always reports a positive count via
// customdata (the absolute value) — the sign flip on the alighting half never
// leaks into the tooltip.
const HOVER_TEMPLATE =
  '%{x}<br>%{customdata:,} passengers<extra>%{fullData.name}</extra>';

// Comparison-mode hover: the trace name is just the dataset (legend shows one
// entry per dataset), so the metric has to be spelled out in the tooltip body.
const kindHover = (kind) =>
  `%{x}<br>${kind}: %{customdata:,}<extra>%{fullData.name}</extra>`;

// `extra` merges trace overrides (legendgroup/showlegend/hovertemplate) for
// the comparison branch.
const barTrace = (name, y, color, customdata, extra = {}) => ({
  type: 'bar',
  name,
  x: TIME_LABELS,
  y,
  customdata,
  marker: { color },
  hovertemplate: HOVER_TEMPLATE,
  ...extra,
});

// Secondary dataset in comparison mode is drawn as a stepped outline over the
// primary's filled silhouette. Shape 'hvh' (not 'hv') centers each flat step
// on its category position — bars are centered on the category too, so the
// outline aligns with the bars instead of sitting half a bin to the right.
const stepTrace = (name, y, color, customdata, extra = {}) => ({
  type: 'scatter',
  mode: 'lines',
  name,
  x: TIME_LABELS,
  y,
  customdata,
  line: { color, width: 1.5, shape: 'hvh' },
  hovertemplate: HOVER_TEMPLATE,
  ...extra,
});

// "Nice" tick step (1/2/5 × 10^n) giving ~`count` divisions up to `max`. Used
// to place symmetric ticks about the zero line with absolute-valued labels
// (Plotly can't abs() tick text, so we relabel explicitly).
const niceStep = (max, count = 4) => {
  if (!(max > 0)) return 1;
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const snapped = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return snapped * mag;
};

const binSeries = (rows) => {
  const boardings = {};
  const alightings = {};
  for (const row of rows) {
    const bins = Array.isArray(row.data) ? row.data : [];
    for (const t of bins) {
      const key = `${String(t.time_bin).slice(0, 2)}:00`;
      boardings[key] = (boardings[key] ?? 0) + (Number(t.boardings) || 0);
      alightings[key] = (alightings[key] ?? 0) + (Number(t.alightings) || 0);
    }
  }
  return {
    boardingsY: TIME_LABELS.map((t) => boardings[t] ?? 0),
    alightingsY: TIME_LABELS.map((t) => alightings[t] ?? 0),
  };
};

/**
 * Sums boardings + alightings across every stop on the selected line, per
 * hourly time bin. One boardings + one alightings trace per dataset in
 * the comparison slots (single dataset → the legacy two-trace plot).
 * Shares its underlying data fetch with PassengersByMunicipality via
 * useLineCantonCounts(Multi).
 */
const LineHourlyDistribution = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedLineMeta, selectedLineModes } = useDashboard();
  const hiddenByFilter = !!selectedLineMeta
    && !lineMatchesFilter(selectedLineMeta?.vehicle, selectedLineModes);

  useResizeOnSidebarChange(sidebarCollapsed);

  const perDataset = useLineCantonCountsMulti(selectedLineMeta);
  const isComparison = perDataset.length > 1;

  const { traces, maxAbs } = useMemo(() => {
    const out = [];
    let peak = 0;
    const track = (arr) => { for (const v of arr) if (v > peak) peak = v; };

    for (const { dataset, rows } of perDataset) {
      if (!rows?.length) continue;
      const { boardingsY, alightingsY } = binSeries(rows);
      track(boardingsY);
      track(alightingsY);
      const downY = alightingsY.map((v) => -v); // alightings mirrored below zero

      if (isComparison) {
        // Color encodes the dataset; direction (up/down) encodes the metric.
        // The primary is a filled silhouette; the secondary is a stepped
        // outline drawn on top of it — this replaces four overlapping
        // translucent bars, which collided into an unreadable smear. A step
        // outline reads cleanly against a filled area and never occludes it.
        // Legend: one entry per dataset — boardings/alightings share the same
        // color+symbol, so per-metric entries were pure repetition. The
        // metric lives in the tooltip (kindHover) and in the up/down halves.
        const make = dataset.isPrimary ? barTrace : stepTrace;
        out.push(
          make(dataset.name, boardingsY, dataset.color, boardingsY, {
            legendgroup: dataset.name,
            hovertemplate: kindHover('Boardings'),
          }),
          make(dataset.name, downY, dataset.color, alightingsY, {
            legendgroup: dataset.name,
            showlegend: false,
            hovertemplate: kindHover('Alightings'),
          })
        );
      } else {
        out.push(
          barTrace('Boardings', boardingsY, '#1f77b4', boardingsY),
          barTrace('Alightings', downY, '#ff7f0e', alightingsY)
        );
      }
    }
    return { traces: out, maxAbs: peak };
  }, [perDataset, isComparison]);

  if (!selectedLineMeta) return <div className="plot-loading">Select a transit line</div>;
  if (hiddenByFilter) return <div className="plot-loading">Selected line hidden by mode filter</div>;
  // Wait for the primary; the secondary's traces appear when its fetch lands.
  if (perDataset.length === 0 || perDataset[0].isLoading) return <PlotLoader />;

  // Symmetric, absolute-valued ticks about the zero line for the diverging axis.
  const step = niceStep(maxAbs, 4);
  const maxTick = Math.max(step, Math.ceil(maxAbs / step) * step);
  const tickvals = [];
  for (let v = -maxTick; v <= maxTick + 1e-9; v += step) tickvals.push(Math.round(v));
  const ticktext = tickvals.map((v) => String(Math.abs(v)));

  const layout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 5, b: 50 },
    xaxis: {
      // Categorical so bargap:0 yields a seamless silhouette (Plotly would
      // otherwise auto-type "HH:MM" as a time axis and leave gaps).
      type: 'category',
      title: { text: 'Time of Day', font: { size: 11 } },
      tickangle: -45,
      tickfont: { size: 9 },
    },
    yaxis: {
      // Diverging: boardings above zero, alightings below. Explicit tickvals +
      // abs-valued ticktext so the mirrored half reads as a positive count.
      title: { text: 'Passengers per hour (boardings ↑ / alightings ↓)', font: { size: 11 } },
      tickfont: { size: 9 },
      range: [-maxTick * 1.05, maxTick * 1.05],
      tickvals,
      ticktext,
      zeroline: true,
      zerolinecolor: '#9ca3af',
      zerolinewidth: 1,
    },
    barmode: 'overlay',
    bargap: 0,
    legend: { orientation: 'h', y: 1.08, x: 0.5, xanchor: 'center', font: { size: 10 } },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
  };

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">
        Hourly Passengers (Line {selectedLineMeta.line_name || selectedLineMeta.line_id}, all stops)
      </h4>
      <Plot
        data={traces}
        layout={layout}
        config={{ ...PLOT_CONFIG_BASE, displayModeBar: isExpanded ? 'hover' : false }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler={true}
      />
    </div>
  );
};

export default LineHourlyDistribution;
