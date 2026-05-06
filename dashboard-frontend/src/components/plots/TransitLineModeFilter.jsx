import React, { useMemo } from 'react';
import { useDashboard } from '../../context/DashboardContext';
import { useData } from '../../context/DataContext';

const FALLBACK_MODES = ['rail', 'bus', 'tram', 'subway', 'ferry', 'funicular', 'cable car', 'other'];

// Junk filter — the source has a few lines tagged "car" or vehicle=["bus","yep"]
// that aren't real PT modes.
const VALID_MODES = new Set(FALLBACK_MODES);

const formatLabel = (m) =>
  m.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const TransitLineModeFilter = () => {
  const { selectedCanton, selectedLineModes, setSelectedLineModes } = useDashboard();
  const { getData } = useData();

  // Mirrors the webmap pattern (TransitModule.jsx): per-canton mode list.
  // Falls back to the superset when no canton is selected ("All") or while
  // the file is still loading.
  const modesByCanton = getData('matsim/transit/transit_modes_by_canton.json');

  const modes = useMemo(() => {
    if (!modesByCanton || typeof modesByCanton !== 'object') return FALLBACK_MODES;

    const useCanton = selectedCanton && selectedCanton !== 'All';
    const source = useCanton && Array.isArray(modesByCanton[selectedCanton])
      ? modesByCanton[selectedCanton]
      : Object.values(modesByCanton).flat();

    const s = new Set();
    for (const v of source) {
      if (typeof v !== 'string') continue;
      if (!VALID_MODES.has(v)) continue;
      s.add(v);
    }
    return s.size ? [...s].sort() : FALLBACK_MODES;
  }, [modesByCanton, selectedCanton]);

  const isAll = !selectedLineModes || selectedLineModes.includes('all') || selectedLineModes.length === 0;
  const value = isAll ? ['all'] : selectedLineModes;

  // Multi-select pattern matches the webmap's TransitModule mode filter so
  // the two surfaces feel consistent. Ctrl/Cmd-click on individual modes;
  // selecting "All" or clearing the selection resets to ['all'].
  const handleChange = (e) => {
    const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
    if (opts.includes('all') || opts.length === 0) {
      setSelectedLineModes(['all']);
    } else {
      setSelectedLineModes(opts);
    }
  };

  return (
    <div className="plot-wrapper line-mode-filter-wrapper">
      <h4 className="plot-title">Mode Filter</h4>
      <div className="mode-filter-container">
        <label className="mode-filter-label">Filter by Mode:</label>
        <select
          multiple
          value={value}
          onChange={handleChange}
          className="mode-filter-select"
        >
          <option value="all">All</option>
          {modes.map((mode) => (
            <option key={mode} value={mode}>
              {formatLabel(mode)}
            </option>
          ))}
        </select>
        <p className="line-mode-filter-hint">
          Ctrl/Cmd-click to pick multiple. Restricts search, lines list, and the map.
        </p>
      </div>
    </div>
  );
};

export default TransitLineModeFilter;
