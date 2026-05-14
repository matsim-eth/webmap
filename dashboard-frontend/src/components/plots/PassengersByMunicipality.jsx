import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { useDashboard } from '../../context/DashboardContext';
import { useResizeOnSidebarChange } from '../../hooks/useResizeOnSidebarChange';
import { useLinePolygonCounts } from '../../hooks/useLinePolygonCounts';
import { lineMatchesFilter } from '../../utils/transitLineFilter';
import PlotLoader from './PlotLoader';

const METRICS = {
  boardings: { label: 'Boardings', color: '#1f77b4' },
  alightings: { label: 'Alightings', color: '#ff7f0e' },
};

const PassengersByMunicipality = ({ sidebarCollapsed, isExpanded = false, metric = 'boardings' }) => {
  const {
    selectedLineMeta,
    selectedMunicipality,
    setSelectedMunicipality,
    selectedLineModes,
    polygonSet,
  } = useDashboard();
  const { label, color } = METRICS[metric] || METRICS.boardings;
  const hiddenByFilter = !!selectedLineMeta && !lineMatchesFilter(selectedLineMeta?.vehicle, selectedLineModes);

  useResizeOnSidebarChange(sidebarCollapsed);

  const { data, isLoading } = useLinePolygonCounts(selectedLineMeta, polygonSet);

  // Sort by the active metric, top 30 (avoids a 200-bar plot for nationwide
  // lines). Zero-metric rows are kept so polygons with no boardings still
  // render bars (just empty).
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const sorted = [...all].sort((a, b) => b[metric] - a[metric]);
    return sorted.slice(0, 30);
  }, [data, metric]);

  if (!selectedLineMeta) {
    return <div className="plot-loading">Search for a transit line above</div>;
  }
  if (hiddenByFilter) {
    return <div className="plot-loading">Selected line hidden by mode filter</div>;
  }
  if (isLoading) {
    return <PlotLoader />;
  }

  const x = rows.map((r) => r.name);
  const y = rows.map((r) => r[metric]);
  const colors = rows.map((r) =>
    selectedMunicipality && String(selectedMunicipality) === String(r.polygon_id)
      ? '#22c55e'
      : color
  );

  // Hover line for kanton (muni path only — custom polygons don't carry it).
  const hasKanton = rows.some((r) => r.kanton);
  const trace = {
    type: 'bar',
    x,
    y,
    marker: { color: colors },
    customdata: rows.map((r) => [r.polygon_id, r.kanton ?? '']),
    hovertemplate: hasKanton
      ? `<b>%{x}</b><br>${label}: %{y:,}<br>Canton: %{customdata[1]}<extra></extra>`
      : `<b>%{x}</b><br>${label}: %{y:,}<extra></extra>`,
  };

  // X-axis label depends on polygon set kind. Custom uses the chosen property
  // name when available so the user knows what each bar represents.
  const polygonKind = polygonSet?.kind === 'custom' ? 'Polygon' : 'Municipality';
  const xAxisLabel = polygonSet?.kind === 'custom' && polygonSet?.nameProperty
    ? polygonSet.nameProperty
    : polygonKind;

  const layout = {
    autosize: true,
    margin: { l: 60, r: 20, t: 5, b: 110 },
    xaxis: {
      title: { text: xAxisLabel, font: { size: 11 } },
      tickangle: -45,
      tickfont: { size: 9 },
      automargin: true,
    },
    yaxis: {
      title: { text: `${label} (daily total)`, font: { size: 11 } },
      tickfont: { size: 9 },
      rangemode: 'nonnegative',
    },
    hovermode: 'closest',
    showlegend: false,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
  };

  const config = {
    responsive: true,
    displayModeBar: isExpanded ? 'hover' : false,
    displaylogo: false,
    toImageButtonOptions: {
      format: 'png',
      filename: `${selectedLineMeta.line_name || selectedLineMeta.line_id}_${metric}_by_${polygonKind.toLowerCase()}`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  const handleClick = (e) => {
    const point = e?.points?.[0];
    if (!point) return;
    const polyId = point.customdata?.[0];
    if (polyId == null) return;
    setSelectedMunicipality(
      selectedMunicipality && String(selectedMunicipality) === String(polyId) ? null : polyId
    );
  };

  const lineLabel = selectedLineMeta.line_name || selectedLineMeta.line_id;
  const title = `${label} by ${polygonKind} (Line ${lineLabel})${
    rows.length === 30 ? ' — top 30' : ''
  }`;

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{title}</h4>
      <Plot
        data={[trace]}
        layout={layout}
        config={config}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler={true}
        onClick={handleClick}
      />
    </div>
  );
};

export default PassengersByMunicipality;
