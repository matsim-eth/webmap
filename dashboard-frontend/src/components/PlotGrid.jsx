import React, { useMemo, useState } from 'react';
import './PlotGrid.css';
import CantonMap from './plots/CantonMap';
import PlotExpanded from './PlotExpanded';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpand } from '@fortawesome/free-solid-svg-icons';
import { useDashboard } from '../context/DashboardContext';
import {
  TAB_LABELS,
  TWO_PLOT_TABS,
  getPlotsForTab,
  buildPtSubQuery,
} from '../config/plots';

const PlotGrid = ({ sidebarCollapsed, activeTab }) => {
  const [expandedPlot, setExpandedPlot] = useState(null);
  const {
    selectedCanton,
    selectedGender,
    selectedIncome,
    selectedAge,
  } = useDashboard();

  const isTwoPlotLayout = TWO_PLOT_TABS.has(activeTab);
  const gridClass = isTwoPlotLayout
    ? 'plot-grid plot-grid-two-plots'
    : 'plot-grid';

  // Resolve the per-tab plot array. The pt-subscription, car-ownership, and
  // demographics tabs close over filter state, so the config exposes them
  // as `(state) => specs` functions instead of static arrays.
  const plots = useMemo(() => {
    const ptSubQuery = buildPtSubQuery({ selectedGender, selectedIncome, selectedAge });
    return getPlotsForTab(activeTab, { selectedCanton, ptSubQuery });
  }, [activeTab, selectedCanton, selectedGender, selectedIncome, selectedAge]);

  // Placeholder grid for tabs without a config yet
  if (!plots) {
    return (
      <div className="plot-grid">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="plot-card">
            <div className="plot-placeholder">
              {TAB_LABELS[activeTab] || activeTab} (WIP) - Plot {i}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className={gridClass}>
        {/* Persistent canton map — always rendered, layout class differs per tab */}
        <div
          key="persistent-canton-map"
          className={isTwoPlotLayout ? 'plot-card persistent-map-two-plots' : 'plot-card persistent-map'}
          style={isTwoPlotLayout ? { gridArea: 'map' } : {}}
        >
          <CantonMap sidebarCollapsed={sidebarCollapsed} activeTab={activeTab} />
          <button
            className="plot-expand-btn"
            onClick={() => setExpandedPlot({
              id: 'canton-map',
              component: CantonMap,
              title: 'Canton Map',
              props: { activeTab },
            })}
            title="Expand plot"
          >
            <FontAwesomeIcon icon={faExpand} />
          </button>
        </div>

        {plots.map((plot, i) => {
          if (plot.placeholder) {
            return (
              <div
                key={plot.id}
                className="plot-card"
                style={plot.gridArea ? { gridArea: plot.gridArea } : {}}
              >
                <div className="plot-placeholder">
                  {TAB_LABELS[activeTab]} (WIP) - Plot {i + 1}
                </div>
              </div>
            );
          }

          const PlotComponent = plot.component;
          return (
            <div
              key={plot.id}
              className="plot-card"
              style={plot.gridArea ? { gridArea: plot.gridArea } : {}}
            >
              <PlotComponent sidebarCollapsed={sidebarCollapsed} {...(plot.props || {})} />
              <button
                className="plot-expand-btn"
                onClick={() => setExpandedPlot(plot)}
                title="Expand plot"
              >
                <FontAwesomeIcon icon={faExpand} />
              </button>
            </div>
          );
        })}
      </div>

      <PlotExpanded
        isOpen={expandedPlot !== null}
        onClose={() => setExpandedPlot(null)}
        expandedComponent={expandedPlot}
      />
    </>
  );
};

export default PlotGrid;
