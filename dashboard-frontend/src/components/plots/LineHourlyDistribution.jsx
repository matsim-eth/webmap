import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { useDashboard } from '../../context/DashboardContext';
import { useResizeOnSidebarChange } from '../../hooks/useResizeOnSidebarChange';
import { useLineCantonCounts } from '../../hooks/useLineCantonCounts';
import { lineMatchesFilter } from '../../utils/transitLineFilter';
import PlotLoader from './PlotLoader';

// 96 fifteen-minute slots, computed once at module load — same for every
// instance / render.
const TIME_LABELS = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
})();
const TICK_LABELS = TIME_LABELS.filter((_, i) => i % 4 === 0);

const PLOT_CONFIG_BASE = {
  responsive: true,
  displaylogo: false,
};

/**
 * Sums boardings + alightings across every stop on the selected line, per
 * 15-minute time bin. One trace per metric. Shares its underlying data
 * fetch with PassengersByMunicipality via useLineCantonCounts.
 */
const LineHourlyDistribution = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedLineMeta, selectedLineModes } = useDashboard();
  const hiddenByFilter = !!selectedLineMeta
    && !lineMatchesFilter(selectedLineMeta?.vehicle, selectedLineModes);

  useResizeOnSidebarChange(sidebarCollapsed);

  const { data, isLoading } = useLineCantonCounts(selectedLineMeta);

  const { boardingsY, alightingsY } = useMemo(() => {
    if (!data?.rows?.length) return { boardingsY: [], alightingsY: [] };
    const boardings = {};
    const alightings = {};
    for (const row of data.rows) {
      const bins = Array.isArray(row.data) ? row.data : [];
      for (const t of bins) {
        const key = String(t.time_bin);
        boardings[key] = (boardings[key] ?? 0) + (Number(t.boardings) || 0);
        alightings[key] = (alightings[key] ?? 0) + (Number(t.alightings) || 0);
      }
    }
    return {
      boardingsY: TIME_LABELS.map((t) => boardings[t] ?? 0),
      alightingsY: TIME_LABELS.map((t) => alightings[t] ?? 0),
    };
  }, [data]);

  if (!selectedLineMeta) return <div className="plot-loading">Select a transit line</div>;
  if (hiddenByFilter) return <div className="plot-loading">Selected line hidden by mode filter</div>;
  if (isLoading) return <PlotLoader />;

  const layout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 5, b: 50 },
    xaxis: {
      title: { text: 'Time of Day', font: { size: 11 } },
      tickangle: -45,
      tickfont: { size: 8 },
      tickvals: TICK_LABELS,
    },
    yaxis: {
      title: { text: 'Passengers per 15 min', font: { size: 11 } },
      tickfont: { size: 9 },
    },
    barmode: 'group',
    legend: { orientation: 'h', y: 1.05, x: 0.5, xanchor: 'center', font: { size: 10 } },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
  };

  const traces = [
    { type: 'bar', name: 'Boardings', x: TIME_LABELS, y: boardingsY, marker: { color: '#1f77b4' } },
    { type: 'bar', name: 'Alightings', x: TIME_LABELS, y: alightingsY, marker: { color: '#ff7f0e' } },
  ];

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">
        Hourly Passengers (Line {selectedLineMeta.line_name || selectedLineMeta.line_id})
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
