import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { useDashboard } from '../../context/DashboardContext';
import { useResizeOnSidebarChange } from '../../hooks/useResizeOnSidebarChange';
import { useLinePolygonCountsMulti } from '../../hooks/useLinePolygonCounts';
import { lineMatchesFilter } from '../../utils/transitLineFilter';
import PlotLoader from './PlotLoader';

const METRICS = {
  boardings: { label: 'Boardings', color: '#1f77b4' },
  alightings: { label: 'Alightings', color: '#ff7f0e' },
};

const HIGHLIGHT = '#22c55e';

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

  const perDataset = useLinePolygonCountsMulti(selectedLineMeta, polygonSet);
  const withRows = perDataset.filter((d) => d.rows);
  const isComparison = perDataset.length > 1;

  // Join datasets on polygon_id, sort by the active metric summed across
  // datasets, top 30 (avoids a 200-bar plot for nationwide lines).
  // Zero-metric rows are kept so polygons with no boardings still render
  // bars (just empty). Single mode reduces to the legacy sort.
  const joined = useMemo(() => {
    const byPoly = new Map();
    for (const { dataset, rows } of perDataset) {
      if (!rows) continue;
      for (const r of rows) {
        let entry = byPoly.get(r.polygon_id);
        if (!entry) {
          entry = { polygon_id: r.polygon_id, name: r.name, kanton: r.kanton, values: {} };
          byPoly.set(r.polygon_id, entry);
        }
        if (entry.kanton == null && r.kanton != null) entry.kanton = r.kanton;
        entry.values[dataset.datasetId] = r;
      }
    }
    const all = [...byPoly.values()];
    const metricSum = (e) =>
      Object.values(e.values).reduce((acc, r) => acc + (r[metric] ?? 0), 0);
    all.sort((a, b) => metricSum(b) - metricSum(a));
    return all.slice(0, 30);
  }, [perDataset, metric]);

  if (!selectedLineMeta) {
    return <div className="plot-loading">Search for a transit line above</div>;
  }
  if (hiddenByFilter) {
    return <div className="plot-loading">Selected line hidden by mode filter</div>;
  }
  // Wait for the primary; the secondary's bars appear when its fetch lands.
  if (perDataset.length === 0 || perDataset[0].isLoading) {
    return <PlotLoader />;
  }

  const x = joined.map((r) => r.name);
  const customdata = joined.map((r) => [r.polygon_id, r.kanton ?? '']);
  const hasKanton = joined.some((r) => r.kanton);
  const isSelected = (r) =>
    selectedMunicipality && String(selectedMunicipality) === String(r.polygon_id);

  const hovertemplate = hasKanton
    ? `<b>%{x}</b><br>${label}: %{y:,}<br>Canton: %{customdata[1]}<extra>${isComparison ? '%{fullData.name}' : ''}</extra>`
    : `<b>%{x}</b><br>${label}: %{y:,}<extra>${isComparison ? '%{fullData.name}' : ''}</extra>`;

  const traces = withRows.map(({ dataset }) => ({
    type: 'bar',
    name: dataset.name,
    x,
    y: joined.map((r) => r.values[dataset.datasetId]?.[metric] ?? 0),
    marker: isComparison
      ? {
          color: dataset.color,
          // Outline the selected polygon's bars so the highlight doesn't
          // erase the per-dataset colors.
          line: {
            color: joined.map((r) => (isSelected(r) ? HIGHLIGHT : 'rgba(0,0,0,0)')),
            width: joined.map((r) => (isSelected(r) ? 2.5 : 0)),
          },
        }
      : { color: joined.map((r) => (isSelected(r) ? HIGHLIGHT : color)) },
    customdata,
    hovertemplate,
  }));

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
    showlegend: isComparison,
    ...(isComparison && {
      barmode: 'group',
      legend: { orientation: 'h', y: 1.05, x: 0.5, xanchor: 'center', font: { size: 10 } },
    }),
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
    joined.length === 30 ? ' — top 30' : ''
  }`;

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{title}</h4>
      <Plot
        data={traces}
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
