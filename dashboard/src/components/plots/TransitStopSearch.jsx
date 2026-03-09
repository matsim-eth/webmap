import React, { useState, useEffect } from 'react';
import './TransitStopSearch.css';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';
import { useDashboard } from '../../context/DashboardContext';

const TransitStopSearch = ({ canton }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredStops, setFilteredStops] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [stopsData, setStopsData] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadWithFallback = useLoadWithFallback();
  const { selectedTransitStop, setSelectedTransitStop, selectedTransitLine, setSelectedTransitLine } = useDashboard();

  // Load transit stops data when canton changes
  useEffect(() => {
    if (!canton || canton === 'All') {
      setStopsData(null);
      setFilteredStops([]);
      setSearchTerm('');
      setSelectedTransitStop(null); // Clear selected stop when canton changes
      return;
    }

    const loadStopsData = async () => {
      setLoading(true);
      setSearchTerm(''); // Clear search term when canton changes
      setFilteredStops([]); // Clear filtered stops
      setSelectedTransitStop(null); // Clear on reload
      try {
        const stopsPath = `matsim/transit/stops_by_canton/${canton}_stops.geojson`;
        const geojson = await loadWithFallback(stopsPath);
        
        if (!geojson || !geojson.features || geojson.features.length === 0) {
          throw new Error('No transit stops data found');
        }
        
        setStopsData(geojson.features);
        console.log(`Loaded ${geojson.features.length} transit stops for canton ${canton}`);
      } catch (error) {
        console.error('Error loading transit stops:', error);
        setStopsData(null);
      } finally {
        setLoading(false);
      }
    };

    loadStopsData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canton]);

  // Sync search term when stop is selected from map
  useEffect(() => {
    if (selectedTransitStop && selectedTransitStop.name) {
      setSearchTerm(selectedTransitStop.name);
      setFilteredStops([]);
    }
  }, [selectedTransitStop]);

  const normalizeString = (str) => {
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  };

  const handleSelectStop = (stop) => {
    if (!stop) return;
    
    const { name, stop_id, lines, modes_list } = stop.properties;
    const coords = stop.geometry.coordinates;
    
    // Parse stop_ids into array format (matching webmap logic)
    let allStopIds = [];
    if (Array.isArray(stop_id)) {
      allStopIds = stop_id;
    } else {
      try {
        allStopIds = JSON.parse(stop_id);
      } catch {
        allStopIds = String(stop_id).split(",").map(id => id.trim());
      }
    }
    
    console.log('Selected stop:', { name, stop_id, stop_ids: allStopIds, lines, modes_list, coords });
    
    // Clear selected line when stop changes
    setSelectedTransitLine(null);
    
    // Update context with selected stop
    setSelectedTransitStop({
      name,
      stop_id,
      stop_ids: allStopIds,
      lines,
      modes_list,
      coords,
      feature: stop
    });
    
    // Show selected stop name in input
    setSearchTerm(name);
    setFilteredStops([]);
    setSelectedIndex(-1);
  };

  const handleInputChange = (e) => {
    const input = e.target.value;
    setSearchTerm(input);
    setSelectedIndex(-1);

    if (input.trim() === '' || !stopsData) {
      setFilteredStops([]);
      return;
    }

    const normalizedInput = normalizeString(input);
    const startsWithMatches = [];
    const containsMatches = [];

    stopsData.forEach(stop => {
      const stopName = stop.properties.name || '';
      const normalized = normalizeString(stopName);
      if (normalized.startsWith(normalizedInput)) {
        startsWithMatches.push(stop);
      } else if (normalized.includes(normalizedInput)) {
        containsMatches.push(stop);
      }
    });

    const suggestions = [
      ...startsWithMatches.sort((a, b) => a.properties.name.localeCompare(b.properties.name)),
      ...containsMatches.sort((a, b) => a.properties.name.localeCompare(b.properties.name))
    ].slice(0, 8);

    setFilteredStops(suggestions);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filteredStops.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && filteredStops.length > 0) {
        handleSelectStop(filteredStops[selectedIndex]);
      } else if (filteredStops.length > 0) {
        handleSelectStop(filteredStops[0]);
      }
    } else if (e.key === 'Escape') {
      setSearchTerm('');
      setFilteredStops([]);
      setSelectedIndex(-1);
    }
  };

  const isDisabled = loading || !stopsData || canton === 'All';
  
  // Get unique lines from selected stop and format them
  const availableLines = selectedTransitStop?.lines
    ? (() => {
        try {
          // Parse lines if it's a string
          const linesArray = typeof selectedTransitStop.lines === 'string' 
            ? JSON.parse(selectedTransitStop.lines) 
            : selectedTransitStop.lines;
          
          // Return array of line objects with name and mode
          if (Array.isArray(linesArray)) {
            // Group by line_id to aggregate duplicate entries
            const lineMap = {};
            linesArray.forEach(line => {
              const lineId = line.line_id;
              if (!lineMap[lineId]) {
                lineMap[lineId] = {
                  line_id: lineId,
                  line_name: line.line_name || line.lineName || line.name || null,
                  mode: line.mode || 'unknown'
                };
              } else {
                // Preserve line_name if current one is missing it
                if (!lineMap[lineId].line_name && (line.line_name || line.lineName || line.name)) {
                  lineMap[lineId].line_name = line.line_name || line.lineName || line.name;
                }
              }
            });
            return Object.values(lineMap).sort((a, b) => {
              const nameA = (a.line_name || a.line_id).toLowerCase();
              const nameB = (b.line_name || b.line_id).toLowerCase();
              return nameA.localeCompare(nameB, undefined, { numeric: true });
            });
          }
          return [];
        } catch {
          return [];
        }
      })()
    : [];

  return (
    <div className="transit-stop-search-inline">
      <label className="control-label">Search for Stop</label>
      <div className="search-wrapper">
        <input
          type="text"
          value={searchTerm}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={loading ? "Loading..." : isDisabled ? "Select a canton" : "Type to search..."}
          className="transit-stop-input-inline"
          disabled={isDisabled}
        />
        
        {filteredStops.length > 0 && (
          <ul className="transit-stop-dropdown">
            {filteredStops.map((stop, index) => (
              <li
                key={index}
                onClick={() => handleSelectStop(stop)}
                className={index === selectedIndex ? "selected" : ""}
              >
                <div className="stop-name">{stop.properties.name}</div>
                {stop.properties.modes_list && Array.isArray(stop.properties.modes_list) && (
                  <div className="stop-modes">
                    {stop.properties.modes_list.join(', ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      
      <label className="control-label">Filter by Line</label>
      <div className="line-filter-wrapper">
        <select
          className="transit-line-select"
          value={selectedTransitLine || ''}
          onChange={(e) => setSelectedTransitLine(e.target.value || null)}
          disabled={!selectedTransitStop || availableLines.length === 0}
        >
          <option value="">All Lines</option>
          {availableLines.map((line) => (
            <option key={line.line_id} value={line.line_id}>
              {line.line_name || line.line_id} ({line.mode})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default TransitStopSearch;
