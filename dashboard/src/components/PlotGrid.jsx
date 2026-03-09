import React, { useState } from 'react';
import './PlotGrid.css';
import CantonMap from './plots/CantonMap';
import HistogramPlot from './plots/HistogramPlot';
import ShareLinePlot from './plots/ShareLinePlot';
import ByDistanceStacked from './plots/ByDistanceStacked';
import DistributionBarPlot from './plots/DistributionBarPlot';
import PtSubscriptionInfo from './plots/PtSubscriptionInfo';
import PassengersByStop from './plots/PassengersByStop';
import TransitStopSummary from './plots/TransitStopSummary';
import TransferMatrix from './plots/TransferMatrix';
import TransferDestinations from './plots/TransferDestinations';
import PlotExpanded from './PlotExpanded';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpand } from '@fortawesome/free-solid-svg-icons';

const TAB_LABELS = {
  'home': 'Home',
  'demographics': 'Demographics',
  'activities': 'Activities',
  'mode': 'Mode',
  'purpose': 'Purpose',
  'stops': 'Stops',
  'pt-subscription': 'PT Subscription',
  'car-ownership': 'Car Ownership',
  'transit-stops': 'Transit Stops',
};

const PlotGrid = ({ sidebarCollapsed, activeTab }) => {
  const [expandedPlot, setExpandedPlot] = useState(null);

  const isTwoPlotLayout = activeTab === 'demographics' || activeTab === 'car-ownership';

  const modePlots = [
    { 
      id: 'distance-histogram', 
      component: HistogramPlot, 
      title: 'Distance Histogram', 
      props: { 
        type: 'mode', 
        plotType: 'distance',
        exportFilename: 'distance-histogram-mode'
      } 
    },
    { 
      id: 'departure-time', 
      component: ShareLinePlot, 
      title: 'Mode Share by Departure Time', 
      props: { 
        type: 'mode', 
        plotType: 'departure',
        title: 'Mode Share by Departure Time',
        xAxisLabel: 'Departure Time',
        exportFilename: 'departure-time-mode'
      } 
    },
    { id: 'mode-distance-stacked', 
      component: ByDistanceStacked, 
      title: 'Mode Distribution by Distance Travelled', 
      props: { type: 'mode' } },
    { 
      id: 'average-distance', 
      component: DistributionBarPlot, 
      title: 'Average Distance (All Modes)',
      props: {
        dataFile: 'avg_dist_data_mode.json',
        title: 'Average Distance (All Modes)',
        xAxisLabel: 'Mode',
        yAxisLabel: 'Distance [km]',
        filterType: 'distance',
        dataTransform: (value) => value / 1000,
        exportFilename: 'average-distance-mode'
      }
    },
    { 
      id: 'mode-share-line', 
      component: ShareLinePlot, 
      title: 'Mode Share by Distance', 
      props: { 
        type: 'mode', 
        plotType: 'distance',
        title: 'Mode Share by Distance',
        xAxisLabel: 'Distance',
        exportFilename: 'mode-share-by-distance'
      } 
    },
  ];

  const purposePlots = [
    { 
      id: 'distance-histogram-purpose', 
      component: HistogramPlot, 
      title: 'Distance Histogram', 
      props: { 
        type: 'purpose', 
        plotType: 'distance',
        exportFilename: 'distance-histogram-purpose'
      } 
    },
    { 
      id: 'departure-time-purpose', 
      component: ShareLinePlot, 
      title: 'Purpose Share by Departure Time', 
      props: { 
        type: 'purpose', 
        plotType: 'departure',
        title: 'Purpose Share by Departure Time',
        xAxisLabel: 'Departure Time',
        exportFilename: 'departure-time-purpose'
      } 
    },
    { id: 'purpose-distance-stacked', 
      component: ByDistanceStacked, 
      title: 'Purpose Distribution by Distance Travelled', 
      props: { type: 'purpose' } },
    { 
      id: 'average-distance-purpose', 
      component: DistributionBarPlot, 
      title: 'Average Distance (All Purposes)',
      props: {
        dataFile: 'avg_dist_data_purpose.json',
        title: 'Average Distance (All Purposes)',
        xAxisLabel: 'Purpose',
        yAxisLabel: 'Distance [km]',
        filterType: 'distance',
        dataTransform: (value) => value / 1000,
        exportFilename: 'average-distance-purpose'
      }
    },
    { 
      id: 'purpose-share-line', 
      component: ShareLinePlot, 
      title: 'Purpose Share by Distance', 
      props: { 
        type: 'purpose', 
        plotType: 'distance',
        title: 'Purpose Share by Distance',
        xAxisLabel: 'Distance',
        exportFilename: 'purpose-share-by-distance'
      } 
    },
  ];

  const activityPlots = [
    { 
      id: 'num-activities', 
      component: DistributionBarPlot, 
      title: 'Number of Activities Per Day',
      props: {
        dataFile: 'num_activities.json',
        title: 'Number of Activities Per Day',
        xAxisLabel: 'Number of Activities',
        filterType: null,
        rightLegend: true,
        xAxisRange: [-0.5, 9.5],
        exportFilename: 'number-of-activities'
      }
    },
    { 
      id: 'frequent-sequences', 
      component: DistributionBarPlot, 
      title: 'Frequent Activity Sequences',
      props: {
        dataFile: 'frequent_sequences.json',
        title: 'Frequent Activity Sequences',
        xAxisLabel: 'Activity Sequence',
        filterType: null,
        rightLegend: true,
        exportFilename: 'frequent-sequences'
      }
    },
    { 
      id: 'out-of-home', 
      component: DistributionBarPlot, 
      title: 'Number of Out of Home Activities',
      props: {
        dataFile: 'out_of_home.json',
        title: 'Number of Out of Home Activities',
        xAxisLabel: 'Number of Activities',
        filterType: null,
        rightLegend: true,
        exportFilename: 'out-of-home-activities'
      }
    },
    { 
      id: 'activity-durations', 
      component: HistogramPlot, 
      title: 'Activity Duration Distribution',
      props: {
        plotType: 'duration',
        title: 'Activity Duration Distribution',
        xAxisLabel: 'Duration (hours)',
        dataFile: 'activity_durations.json',
        exportFilename: 'activity-duration-distribution'
      }
    },
    { 
      id: 'departure-times', 
      component: HistogramPlot, 
      title: 'Departure Times by Activity',
      props: {
        plotType: 'departure',
        title: 'Departure Times by Activity',
        xAxisLabel: 'Time of Day',
        dataFile: 'departure_times.json',
        exportFilename: 'departure-times-by-activity'
      }
    },
  ];

  const ptSubscriptionPlots = [
    { 
      id: 'pt-subscription-distribution', 
      component: DistributionBarPlot, 
      title: 'PT Subscription Distribution',
      props: {
        dataFile: 'pt_subscriptions.json',
        title: 'PT Subscription Distribution',
        xAxisLabel: 'Subscription Type',
        filterType: null,
        rightLegend: true,
        exportFilename: 'pt-subscription-distribution'
      }
    },
    { 
      id: 'pt-subscription-by-gender', 
      component: DistributionBarPlot, 
      title: 'PT Subscription by Gender',
      props: {
        dataFile: 'pt_sub_gender.json',
        title: 'PT Subscription by Gender',
        xAxisLabel: 'Subscription Type',
        filterType: 'gender',
        rightLegend: true,
        exportFilename: 'pt-subscription-by-gender'
      }
    },
    { 
      id: 'pt-subscription-by-income', 
      component: DistributionBarPlot, 
      title: 'PT Subscription by Income',
      props: {
        dataFile: 'pt_sub_income.json',
        title: 'PT Subscription by Income',
        xAxisLabel: 'Subscription Type',
        filterType: 'income',
        rightLegend: true,
        exportFilename: 'pt-subscription-by-income'
      }
    },
    { 
      id: 'pt-subscription-by-age', 
      component: DistributionBarPlot, 
      title: 'PT Subscription by Age',
      props: {
        dataFile: 'pt_sub_age.json',
        title: 'PT Subscription by Age',
        xAxisLabel: 'Subscription Type',
        filterType: 'age',
        rightLegend: true,
        exportFilename: 'pt-subscription-by-age'
      }
    },
    {
      id: 'pt-subscription-info',
      component: PtSubscriptionInfo,
      title: 'Swiss PT Subscription Types'
    },
  ];

  const carAvailabilityPlots = [
    { 
      id: 'car-ownership-distribution', 
      component: DistributionBarPlot, 
      title: 'Car Ownership Distribution', 
      gridArea: 'top',
      props: {
        dataFile: 'car_availability.json',
        title: 'Car Ownership Distribution',
        xAxisLabel: 'Number of Cars',
        filterType: null,
        rightLegend: true,
        customCategories: [
          { label: '0', key: '0' },
          { label: '1', key: '1' },
          { label: '2', key: '2' },
          { label: '3+', key: '3' }
        ],
        exportFilename: 'car-ownership-distribution'
      }
    },
    { 
      id: 'car-ownership-by-income', 
      component: DistributionBarPlot, 
      title: 'Car Ownership by Income', 
      gridArea: 'bottom',
      props: {
        dataFile: 'num_cars_income.json',
        title: 'Car Ownership by Income',
        xAxisLabel: 'Number of Cars',
        filterType: 'income',
        rightLegend: true,
        customCategories: [
          { label: '0', key: '0' },
          { label: '1', key: '1' },
          { label: '2', key: '2' },
          { label: '3+', key: '3' }
        ],
        exportFilename: 'car-ownership-by-income'
      }
    },
  ];

  const demographicsPlots = [
    { 
      id: 'age-distribution', 
      component: DistributionBarPlot, 
      title: 'Age Group Distribution', 
      gridArea: 'top',
      props: {
        dataFile: 'age.json',
        title: 'Age Group Distribution',
        xAxisLabel: 'Age Group',
        filterType: null,
        exportFilename: 'age-distribution'
      }
    },
    { 
      id: 'gender-distribution', 
      component: DistributionBarPlot, 
      title: 'Gender Distribution', 
      gridArea: 'bottom',
      props: {
        dataFile: 'gender.json',
        title: 'Gender Distribution',
        xAxisLabel: 'Gender',
        filterType: null,
        customCategories: [
          { label: 'Male', key: '0' },
          { label: 'Female', key: '1' }
        ],
        yAxisRange: [0, 58],
        exportFilename: 'gender-distribution'
      }
    },
  ];

  const transitStopsPlots = [
    { id: 'boardings-by-stop', component: PassengersByStop, title: 'Boardings by Stop', props: { metric: 'boardings' } },
    { id: 'alightings-by-stop', component: PassengersByStop, title: 'Alightings by Stop', props: { metric: 'alightings' } },
    { id: 'transit-stop-summary', component: TransitStopSummary, title: 'Daily Totals' },
    { id: 'transfer-matrix', component: TransferMatrix, title: 'Transfer Matrix' },
    { id: 'transfer-destinations', component: TransferDestinations, title: 'Transfer Destinations' },
  ];

  // set plots based on active tab
  let plots = null;
  let gridClass = 'plot-grid'; // default 3x2 grid
  
  if (activeTab === 'mode') {
    plots = modePlots;
  } else if (activeTab === 'purpose') {
    plots = purposePlots;
  } else if (activeTab === 'activities') {
    plots = activityPlots;
  } else if (activeTab === 'pt-subscription') {
    plots = ptSubscriptionPlots;
  } else if (activeTab === 'car-ownership') {
    plots = carAvailabilityPlots;
    gridClass = 'plot-grid plot-grid-two-plots'; // 2 plot layout
  } else if (activeTab === 'demographics') {
    plots = demographicsPlots;
    gridClass = 'plot-grid plot-grid-two-plots'; // 2 plot layout
  } else if (activeTab === 'transit-stops') {
    plots = transitStopsPlots;
  }

  // placeholders for other tabs
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
        {/* Canton Map*/}
        <div 
          key="persistent-canton-map" 
          className={isTwoPlotLayout ? "plot-card persistent-map-two-plots" : "plot-card persistent-map"}
          style={isTwoPlotLayout ? { gridArea: 'map' } : {}}
        >
          <CantonMap sidebarCollapsed={sidebarCollapsed} activeTab={activeTab} />
          <button 
            className="plot-expand-btn"
            onClick={() => setExpandedPlot({ 
              id: 'canton-map', 
              component: CantonMap, 
              title: 'Canton Map',
              props: { activeTab }
            })}
            title="Expand plot"
          >
            <FontAwesomeIcon icon={faExpand} />
          </button>
        </div>

        {plots.map((plot, i) => {
          if (plot.placeholder) {
            return (
              <div key={plot.id} className="plot-card" style={plot.gridArea ? { gridArea: plot.gridArea } : {}}>
                <div className="plot-placeholder">
                  {TAB_LABELS[activeTab]} (WIP) - Plot {i + 1}
                </div>
              </div>
            );
          }

          const PlotComponent = plot.component;
          return (
            <div key={plot.id} className="plot-card" style={plot.gridArea ? { gridArea: plot.gridArea } : {}}>
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
