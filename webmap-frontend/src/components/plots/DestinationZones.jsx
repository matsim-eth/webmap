import React, { useState, useCallback, useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import cantonAlias from "../../utils/canton_alias.json";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useQuery } from "@tanstack/react-query";

const MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4"  // default color for all modes
};


const DestinationZones = ({ canton, onTotalOutflowChange, timeRange, setTimeRange }) => {
  const [selectedMode, setSelectedMode] = useState('all');
  const [selectedPurpose, setSelectedPurpose] = useState('all');
  const [selectedCanton, setSelectedCanton] = useState('all');
  const [isOriginMode, setIsOriginMode] = useState(true);

  const loadWithFallback = useLoadWithFallback();
  
  const modes = [
    { value: 'all', label: 'All Modes' },
    { value: 'car', label: 'Car' },
    { value: 'pt', label: 'Public Transport' },
    { value: 'bike', label: 'Bicycle' },
    { value: 'walk', label: 'Walk' }
  ];
  
  const purposes = [
    { value: 'all', label: 'All Purposes'},
    { value: 'work', label: 'Work'},
    { value: 'education', label: 'Education'},
    { value: 'shop', label: 'Shopping'},
    { value: 'leisure', label: 'Leisure'}
  ];
  
  const cantonOptions = [
    { value: 'all', label: 'All Cantons' },
    ...Object.entries(cantonAlias).map(([value, label]) => ({ value, label }))
  ];
  
  const timeToLabel = (value) => {
    const hour = Math.floor(value / 4);
    const minute = (value % 4) * 15;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  const { data: plotData } = useQuery({
    queryKey: ['destination-zones', canton],
    queryFn: () => loadWithFallback(`destination_data/${canton}.json`),
    enabled: !!canton,
  });
  
  const processData = () => {
    if (!plotData) return null;
    
    // reverse mapping of display names to internal values
    const reverseCantonMap = Object.entries(cantonAlias).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});
    
    // filter by role (origin/destination mode)
    let filteredData = plotData.filter(d => 
      d.role === (isOriginMode ? 'origin' : 'destination')
    );
    
    // filter by canton
    if (selectedCanton !== 'all') {
      // get the display name to match the internal representation
      filteredData = filteredData.filter(d => {
        if (isOriginMode) {
          // In origin mode, filter by destination canton
          return d.destination === selectedCanton || reverseCantonMap[d.destination] === selectedCanton;
        } else {
          // In destination mode, filter by origin canton
          return d.origin === selectedCanton || reverseCantonMap[d.origin] === selectedCanton;
        }
      });
    }
    // filter by transport mode
    if (selectedMode !== 'all') {
      filteredData = filteredData.filter(d => d.mode === selectedMode);
    }
    // filter by trip purpose 
    if (selectedPurpose !== 'all') {
      filteredData = filteredData.filter(d => d.purpose === selectedPurpose);
    }
    
    // aggregate the filtered bins
    const aggregatedBins = {};
    filteredData.forEach(entry => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        // convert HH:MM time to slider index (0-96)
        const [hours, minutes] = time.split(':').map(Number);
        const timeIndex = hours * 4 + Math.floor(minutes / 15);
        
        // limit display to selected time range
        if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
          if (!aggregatedBins[time]) {
            aggregatedBins[time] = 0;
          }
          aggregatedBins[time] += count;
        }
      });
    });
    
    // sort trip counts by time
    const times = Object.keys(aggregatedBins).sort();
    const counts = times.map(t => aggregatedBins[t]);
    
    return { times, counts };
  };
  
  const data = processData();
  
  // Derived: compute trip outflow totals and notify parent
  const prevOutflowRef = useRef(null);
  const outflowData = useMemo(() => {
    if (!plotData) return null;

    const reverseCantonMap = Object.entries(cantonAlias).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});

    let filteredDataForChoropleth = plotData.filter(d =>
      d.role === (isOriginMode ? 'origin' : 'destination')
    );

    if (selectedPurpose !== 'all') {
      filteredDataForChoropleth = filteredDataForChoropleth.filter(d => d.purpose === selectedPurpose);
    }

    const initModeTotals = () => ({ all: 0, car: 0, pt: 0, bike: 0, walk: 0 });

    const modeTotals = initModeTotals();
    const cantonTotals = {};

    filteredDataForChoropleth.forEach(entry => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        const [hours, minutes] = time.split(':').map(Number);
        const timeIndex = hours * 4 + Math.floor(minutes / 15);
        if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
          modeTotals.all += count;
          if (modeTotals[entry.mode] !== undefined) {
            modeTotals[entry.mode] += count;
          }

          let cantonKey = isOriginMode ? entry.destination : entry.origin;
          if (reverseCantonMap[cantonKey]) {
            cantonKey = reverseCantonMap[cantonKey];
          }
          if (!cantonTotals[cantonKey]) cantonTotals[cantonKey] = initModeTotals();
          cantonTotals[cantonKey].all += count;
          if (cantonTotals[cantonKey][entry.mode] !== undefined) {
            cantonTotals[cantonKey][entry.mode] += count;
          }
        }
      });
    });

    return { all: modeTotals, perCanton: cantonTotals, selectedMode: selectedMode };
  }, [plotData, selectedCanton, selectedMode, selectedPurpose, timeRange, isOriginMode]);

  // Notify parent when outflow data changes
  if (onTotalOutflowChange && outflowData) {
    const key = JSON.stringify(outflowData);
    if (key !== prevOutflowRef.current) {
      prevOutflowRef.current = key;
      onTotalOutflowChange(outflowData);
    }
  }
  
  if (!plotData) {
    return (
      <div className="plot-container">
        <p className="plot-empty">Click a canton to load destination data.</p>
      </div>
    );
  }

  return (
    <div className="plot-container">
      <h3>{isOriginMode ? "Origin" : "Destination"} Canton: {cantonAlias[canton]}</h3>

      <div className="plot-time-row">
        <label className={`plot-toggle`}>
          <span className={isOriginMode ? "plot-toggle-active" : ""}>Origin</span>
          <span className={`plot-toggle-track ${!isOriginMode ? "is-on" : ""}`} onClick={() => setIsOriginMode((p) => !p)}>
            <input
              type="checkbox"
              checked={!isOriginMode}
              onChange={() => setIsOriginMode((prev) => !prev)}
            />
            <span className="plot-toggle-thumb" />
          </span>
          <span className={!isOriginMode ? "plot-toggle-active" : ""}>Destination</span>
        </label>

        <div className="plot-time-slider">
          <span className="plot-time-label">
            Time · {formatTimeLabel(timeRange[0])} – {formatTimeLabel(timeRange[1])}
          </span>
          <Slider
            range
            min={0}
            max={96}
            step={1}
            marks={marks}
            value={timeRange}
            onChange={(val) => setTimeRange(val)}
            allowCross={false}
          />
        </div>
      </div>

      <div className="plot-controls">
        <div className="plot-controls-group">
          <span className="plot-controls-label">Transport Mode</span>
          {modes.map(mode => (
            <label key={mode.value} htmlFor={`mode-${mode.value}`}>
              <input
                type="radio"
                id={`mode-${mode.value}`}
                name="transport-mode"
                value={mode.value}
                checked={selectedMode === mode.value}
                onChange={(e) => setSelectedMode(e.target.value)}
              />
              {mode.label}
            </label>
          ))}
        </div>

        <div className="plot-controls-group">
          <span className="plot-controls-label">Trip Purpose</span>
          {purposes.map(purpose => (
            <label key={purpose.value} htmlFor={`purpose-${purpose.value}`}>
              <input
                type="radio"
                id={`purpose-${purpose.value}`}
                name="trip-purpose"
                value={purpose.value}
                checked={selectedPurpose === purpose.value}
                onChange={(e) => setSelectedPurpose(e.target.value)}
              />
              {purpose.label}
            </label>
          ))}
        </div>

        <div className="plot-controls-group">
          <span className="plot-controls-label">
            {isOriginMode ? "Destination Canton" : "Origin Canton"}
          </span>
          <select
            className="plot-select"
            value={selectedCanton}
            onChange={(e) => setSelectedCanton(e.target.value)}
          >
            {cantonOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="plot-card">
        <div className="plot-card-header">
          <h4 style={{ margin: 0 }}>Trip Counts</h4>
        </div>
        <Plot
          data={[
            {
              x: data.times,
              y: data.counts,
              type: "bar",
              marker: { color: MODE_COLORS[selectedMode] || MODE_COLORS.all },
            },
          ]}
          layout={{
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: { title: { text: "Hour", standoff: 8 }, tickangle: -45, automargin: true },
            yaxis: { title: "Trip Count" },
            height: 260,
            width: 520,
            paper_bgcolor: "rgba(255,255,255,0)",
            plot_bgcolor: "rgba(255,255,255,0)",
          }}
        />
      </div>
    </div>
  );
};

export default DestinationZones;