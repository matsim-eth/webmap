/**
 * Per-tab plot configuration for the dashboard PlotGrid.
 *
 * Each entry in `TAB_PLOTS` is either:
 *   - a static array of plot specs (mode, purpose, activities, transit-stops,
 *     speed); or
 *   - a function `(state) => specs` for tabs whose plots depend on dashboard
 *     filter state (pt-subscription closes over the gender/income/age
 *     filters; car-ownership and demographics close over the selected canton).
 *
 * A plot spec is `{ id, component, title, props?, gridArea?, placeholder? }`.
 * `gridArea` is used by the two-plot tabs (demographics, car-ownership) to
 * place plots into named CSS grid areas; the default 3×2 grid leaves it
 * unset.
 */

import HistogramPlot from '../components/plots/HistogramPlot';
import ShareLinePlot from '../components/plots/ShareLinePlot';
import ByDistanceStacked from '../components/plots/ByDistanceStacked';
import DistributionBarPlot from '../components/plots/DistributionBarPlot';
import PtSubscriptionInfo from '../components/plots/PtSubscriptionInfo';
import PassengersByStop from '../components/plots/PassengersByStop';
import PassengersByMunicipality from '../components/plots/PassengersByMunicipality';
import LinesAtStop from '../components/plots/LinesAtStop';
import TransitLineModeFilter from '../components/plots/TransitLineModeFilter';
import LineHourlyDistribution from '../components/plots/LineHourlyDistribution';
import TransitStopSummary from '../components/plots/TransitStopSummary';
import TransferMatrix from '../components/plots/TransferMatrix';
import TransferDestinations from '../components/plots/TransferDestinations';
import SpeedSummary from '../components/plots/SpeedSummary';
import SpeedByRoadType from '../components/plots/SpeedByRoadType';
import SpeedByTime from '../components/plots/SpeedByTime';
import SpeedByTimePerRoadType from '../components/plots/SpeedByTimePerRoadType';

// All speed plots share a single unfiltered backend fetch — road_type filter
// is applied client-side so switching filters is instant (no re-fetch).
const SPEED_URL = '/backend/data/{datasetId}/speed_dashboard.json';

const MODE_PLOTS = [
  {
    id: 'distance-histogram',
    component: HistogramPlot,
    title: 'Distance Histogram',
    props: {
      type: 'mode',
      plotType: 'distance',
      backendUrlTemplate: '/backend/data/{datasetId}/histogram_distance.json?group_by=mode',
      exportFilename: 'distance-histogram-mode',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/lineplot.json?group_by=mode',
      exportFilename: 'departure-time-mode',
    },
  },
  {
    id: 'mode-distance-stacked',
    component: ByDistanceStacked,
    title: 'Mode Distribution by Distance Travelled',
    props: {
      type: 'mode',
      backendUrlTemplate: '/backend/data/{datasetId}/stacked_bar_distance.json?group_by=mode',
    },
  },
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
      backendUrlTemplate: '/backend/data/{datasetId}/avg_distance.json?group_by=mode',
      dataTransform: (value) => value / 1000,
      exportFilename: 'average-distance-mode',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/lineplot.json?group_by=mode',
      exportFilename: 'mode-share-by-distance',
    },
  },
];

const PURPOSE_PLOTS = [
  {
    id: 'distance-histogram-purpose',
    component: HistogramPlot,
    title: 'Distance Histogram',
    props: {
      type: 'purpose',
      plotType: 'distance',
      backendUrlTemplate: '/backend/data/{datasetId}/histogram_distance.json?group_by=purpose',
      exportFilename: 'distance-histogram-purpose',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/lineplot.json?group_by=purpose',
      exportFilename: 'departure-time-purpose',
    },
  },
  {
    id: 'purpose-distance-stacked',
    component: ByDistanceStacked,
    title: 'Purpose Distribution by Distance Travelled',
    props: {
      type: 'purpose',
      backendUrlTemplate: '/backend/data/{datasetId}/stacked_bar_distance.json?group_by=purpose',
    },
  },
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
      backendUrlTemplate: '/backend/data/{datasetId}/avg_distance.json?group_by=purpose',
      dataTransform: (value) => value / 1000,
      exportFilename: 'average-distance-purpose',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/lineplot.json?group_by=purpose',
      exportFilename: 'purpose-share-by-distance',
    },
  },
];

const ACTIVITY_PLOTS = [
  {
    id: 'num-activities',
    component: DistributionBarPlot,
    title: 'Number of Activities Per Day',
    props: {
      dataFile: 'num_activities.json',
      title: 'Number of Activities Per Day',
      xAxisLabel: 'Number of Activities',
      filterType: null,
      backendUrlTemplate: '/backend/data/{datasetId}/num_activities.json',
      rightLegend: true,
      xAxisRange: [-0.5, 9.5],
      exportFilename: 'number-of-activities',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/frequent_sequences.json',
      rightLegend: true,
      exportFilename: 'frequent-sequences',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/out_of_home.json',
      rightLegend: true,
      exportFilename: 'out-of-home-activities',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/activity_durations.json',
      exportFilename: 'activity-duration-distribution',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/departure_times.json',
      exportFilename: 'departure-times-by-activity',
    },
  },
];

const SPEED_PLOTS = [
  {
    id: 'speed-summary',
    component: SpeedSummary,
    title: 'Network Summary',
    props: { backendUrlTemplate: SPEED_URL },
  },
  {
    id: 'speed-by-road-type',
    component: SpeedByRoadType,
    title: 'Speed by Road Type',
    props: { backendUrlTemplate: SPEED_URL },
  },
  {
    id: 'speed-by-time-per-road-type',
    component: SpeedByTimePerRoadType,
    title: 'Speed by Time — per Road Type',
    props: { backendUrlTemplate: SPEED_URL },
  },
  {
    id: 'speed-by-time',
    component: SpeedByTime,
    title: 'Average Speed by Time of Day',
    props: {
      metric: 'avg_speed_kmh',
      title: 'Average Speed by Time of Day',
      yAxisLabel: 'Speed [km/h]',
      backendUrlTemplate: SPEED_URL,
      exportFilename: 'speed-by-time',
    },
  },
  {
    id: 'congestion-by-time',
    component: SpeedByTime,
    title: 'Congestion by Time of Day',
    props: {
      metric: 'congestion_index',
      title: 'Congestion Index by Time of Day',
      yAxisLabel: 'Congestion [% of freespeed]',
      backendUrlTemplate: SPEED_URL,
      exportFilename: 'congestion-by-time',
    },
  },
];

const TRANSIT_STOPS_PLOTS = [
  { id: 'boardings-by-stop', component: PassengersByStop, title: 'Boardings by Stop', props: { metric: 'boardings' } },
  { id: 'alightings-by-stop', component: PassengersByStop, title: 'Alightings by Stop', props: { metric: 'alightings' } },
  { id: 'transit-stop-summary', component: TransitStopSummary, title: 'Daily Totals' },
  { id: 'transfer-matrix', component: TransferMatrix, title: 'Transfer Matrix' },
  { id: 'transfer-destinations', component: TransferDestinations, title: 'Transfer Destinations' },
];

const TRANSIT_LINES_PLOTS = [
  // Cell 2 — search/filter sibling: mode toggles drive search + lines list + map.
  { id: 'transit-line-mode-filter', component: TransitLineModeFilter, title: 'Mode Filter' },
  // Cell 3 — populated when a stop is clicked on the map.
  { id: 'lines-at-stop', component: LinesAtStop, title: 'Lines at Stop' },
  // Cells 4–5 — populated when a line is selected.
  {
    id: 'boardings-by-municipality',
    component: PassengersByMunicipality,
    title: 'Boardings by Municipality',
    props: { metric: 'boardings' },
  },
  {
    id: 'alightings-by-municipality',
    component: PassengersByMunicipality,
    title: 'Alightings by Municipality',
    props: { metric: 'alightings' },
  },
  // Cell 6 — hourly distribution across all stops on the line.
  { id: 'line-hourly', component: LineHourlyDistribution, title: 'Hourly Passengers (Line)' },
];

/**
 * PT subscription tab — distribution plot uses the combined gender/income/age
 * filters as backend query params; the breakdown plots ignore those (they
 * fan out internally).
 */
const ptSubscriptionPlots = ({ ptSubQuery }) => [
  {
    id: 'pt-subscription-distribution',
    component: DistributionBarPlot,
    title: 'PT Subscription Distribution',
    props: {
      dataFile: 'pt_subscriptions.json',
      title: 'PT Subscription Distribution',
      xAxisLabel: 'Subscription Type',
      filterType: null,
      backendUrlTemplate: '/backend/data/{datasetId}/pt_sub.json',
      backendQuery: ptSubQuery,
      rightLegend: true,
      exportFilename: 'pt-subscription-distribution',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/pt_sub.json?breakdown=gender',
      rightLegend: true,
      exportFilename: 'pt-subscription-by-gender',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/pt_sub.json?breakdown=income',
      rightLegend: true,
      exportFilename: 'pt-subscription-by-income',
    },
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
      backendUrlTemplate: '/backend/data/{datasetId}/pt_sub.json?breakdown=age',
      rightLegend: true,
      exportFilename: 'pt-subscription-by-age',
    },
  },
  {
    id: 'pt-subscription-info',
    component: PtSubscriptionInfo,
    title: 'Swiss PT Subscription Types',
  },
];

const carAvailabilityPlots = ({ selectedCanton }) => [
  {
    id: 'car-ownership-distribution',
    component: DistributionBarPlot,
    title: 'Car Availability Distribution',
    gridArea: 'top',
    props: {
      dataFile: 'car_availability.json',
      title: 'Car Availability Distribution',
      xAxisLabel: 'Number of Cars',
      filterType: null,
      backendUrlTemplate: '/backend/data/{datasetId}/car_availability.json',
      rightLegend: true,
      customCategories: [
        { label: 'Always', key: '0' },
        { label: 'Sometimes', key: '1' },
        { label: 'Never', key: '2' },
      ],
      exportFilename: 'car-availability-distribution',
    },
  },
  {
    id: 'car-ownership-by-income',
    component: DistributionBarPlot,
    title: 'Car Ownership by Income',
    gridArea: 'bottom',
    props: {
      dataFile: 'num_cars_income.json',
      canton: selectedCanton,
      title: 'Car Ownership by Income',
      xAxisLabel: 'Number of Cars',
      filterType: 'income',
      backendUrlTemplate: '/backend/data/{datasetId}/num_cars.json?breakdown=income',
      rightLegend: true,
      customCategories: [
        { label: '0', key: '0' },
        { label: '1', key: '1' },
        { label: '2', key: '2' },
        { label: '3+', key: '3' },
      ],
      exportFilename: 'car-ownership-by-filter',
    },
  },
];

const demographicsPlots = ({ selectedCanton }) => [
  {
    id: 'age-distribution',
    component: DistributionBarPlot,
    title: 'Age Group Distribution',
    gridArea: 'top',
    props: {
      dataFile: 'age.json',
      canton: selectedCanton,
      title: 'Age Group Distribution',
      xAxisLabel: 'Age Group',
      filterType: null,
      backendUrlTemplate: '/backend/data/{datasetId}/age.json',
      exportFilename: 'age-distribution',
    },
  },
  {
    id: 'gender-distribution',
    component: DistributionBarPlot,
    title: 'Gender Distribution',
    gridArea: 'bottom',
    props: {
      dataFile: 'gender.json',
      canton: selectedCanton,
      title: 'Gender Distribution',
      xAxisLabel: 'Gender',
      filterType: null,
      backendUrlTemplate: '/backend/data/{datasetId}/gender.json',
      customCategories: [
        { label: 'Male', key: '0' },
        { label: 'Female', key: '1' },
      ],
      yAxisRange: [0, 58],
      exportFilename: 'gender-distribution',
    },
  },
];

/**
 * Map from `activeTab` → either a static plot array or `(state) => array`.
 * `getPlotsForTab(activeTab, state)` resolves the call site without
 * branching on tab name.
 */
export const TAB_PLOTS = {
  mode: MODE_PLOTS,
  purpose: PURPOSE_PLOTS,
  activities: ACTIVITY_PLOTS,
  'pt-subscription': ptSubscriptionPlots,
  'car-ownership': carAvailabilityPlots,
  demographics: demographicsPlots,
  'transit-stops': TRANSIT_STOPS_PLOTS,
  'transit-lines': TRANSIT_LINES_PLOTS,
  speed: SPEED_PLOTS,
};

/** Tabs whose CSS layout is `plot-grid plot-grid-two-plots` (named grid areas). */
export const TWO_PLOT_TABS = new Set(['demographics', 'car-ownership']);

/**
 * Per-tab grid layout class. Tabs not listed fall back to the default 3×2.
 * The map slot (CSS class `persistent-map-named-area`) uses `gridArea: 'map'`
 * for any tab that appears here.
 */
export const TAB_LAYOUT_CLASS = {
  demographics: 'plot-grid-two-plots',
  'car-ownership': 'plot-grid-two-plots',
};

/** Header labels for the placeholder rendering on WIP tabs. */
export const TAB_LABELS = {
  home: 'Home',
  demographics: 'Demographics',
  activities: 'Activities',
  mode: 'Mode',
  purpose: 'Purpose',
  stops: 'Stops',
  'pt-subscription': 'PT Subscription',
  'car-ownership': 'Car Ownership',
  'transit-stops': 'Transit Stops',
  'transit-lines': 'Transit Lines',
  speed: 'Speed',
};

/** Resolve a tab to its plot array, calling factory functions with state. */
export function getPlotsForTab(activeTab, state) {
  const entry = TAB_PLOTS[activeTab];
  if (!entry) return null;
  return typeof entry === 'function' ? entry(state) : entry;
}

/**
 * Build the ?gender/?income_class/?age_min/?age_max param object the
 * pt-subscription distribution plot needs. Lives in this module because the
 * config is the only consumer.
 */
export function buildPtSubQuery({ selectedGender, selectedIncome, selectedAge }) {
  const q = {};
  if (selectedGender !== 'all') q.gender = selectedGender === 'male' ? '0' : '1';
  if (selectedIncome !== 'all') q.income_class = selectedIncome;
  if (selectedAge !== 'all') {
    const m = selectedAge.match(/\[(\d+),\s*(\d+)\)/);
    if (m) {
      q.age_min = m[1];
      q.age_max = m[2];
    }
  }
  return q;
}
