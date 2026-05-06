import React, { useMemo, useRef } from 'react';
import { useDashboard } from '../../context/DashboardContext';
import { useData } from '../../context/DataContext';
import {
  toLineList,
  dedupeLinesByLineId,
  buildSelectedLineMeta,
  isModeFilterActive,
} from '../../utils/transitLineFilter';

const LinesAtStop = () => {
  const {
    selectedTransitStop,
    selectedLineMeta, setSelectedLineMeta,
    setSelectedMunicipality,
    selectedLineModes,
  } = useDashboard();
  const { getData } = useData();

  // Whole-Switzerland line catalog. We only need it to look up the cantons[]
  // and route_id[] for the line the user picks.
  const allLinesRaw = getData('boarding_data_by_line.json');
  const lineCatalog = useMemo(() => {
    const m = new Map();
    for (const e of toLineList(allLinesRaw)) {
      if (!e?.line_id) continue;
      m.set(String(e.line_id), e);
    }
    return m;
  }, [allLinesRaw]);

  // Single dedupe pass — `lines` (filter applied) and `modesSummary` (no filter)
  // share it. modesSummary is computed before any early return so hook order
  // stays stable.
  const allDeduped = useMemo(
    () => dedupeLinesByLineId(selectedTransitStop?.lines),
    [selectedTransitStop]
  );

  const lines = useMemo(() => {
    if (!isModeFilterActive(selectedLineModes)) return allDeduped;
    return allDeduped.filter((l) => selectedLineModes.includes(String(l.mode)));
  }, [allDeduped, selectedLineModes]);

  const modesSummary = useMemo(
    () => [...new Set(allDeduped.map((l) => l.mode).filter(Boolean))].join(', '),
    [allDeduped]
  );

  // Auto-select when a stop has exactly one (filtered) line. Tracked by
  // stop + mode-filter signature so swapping stops or adjusting the filter
  // triggers a fresh check; doesn't fight manual deselection on the same
  // stop because the key only changes on stop swap. Gated on catalog being
  // loaded — otherwise the cantons[] would bake in as `[]` and disable the
  // dependent queries.
  const autoSelectKeyRef = useRef(null);
  const autoSelectKey = `${selectedTransitStop?.stop_id ?? ''}|${(selectedLineModes ?? []).join(',')}`;
  if (autoSelectKeyRef.current !== autoSelectKey && allLinesRaw) {
    autoSelectKeyRef.current = autoSelectKey;
    if (selectedTransitStop && lines.length === 1) {
      const only = lines[0];
      const alreadySelected =
        selectedLineMeta && String(selectedLineMeta.line_id) === String(only.line_id);
      if (!alreadySelected) {
        setSelectedLineMeta(buildSelectedLineMeta(only, lineCatalog.get(String(only.line_id))));
        setSelectedMunicipality(null);
      }
    }
  }

  if (!selectedTransitStop) {
    return (
      <div className="plot-wrapper lines-at-stop-wrapper">
        <h4 className="plot-title">Lines at Stop</h4>
        <div className="plot-loading">
          Click a canton, then click a stop to see the lines passing through it.
        </div>
      </div>
    );
  }

  const handleLineClick = (line) => {
    setSelectedLineMeta(buildSelectedLineMeta(line, lineCatalog.get(String(line.line_id))));
    setSelectedMunicipality(null);
  };

  return (
    <div className="plot-wrapper lines-at-stop-wrapper">
      <h4 className="plot-title">Lines at {selectedTransitStop.name}</h4>
      <div className="lines-at-stop-meta">
        {modesSummary && <span>Modes: {modesSummary}</span>}
        <span>{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </div>
      <div className="lines-at-stop-badges">
        {lines.length === 0 ? (
          <div className="plot-loading">No lines associated with this stop.</div>
        ) : (
          <div className="badge-container">
            {lines.map((line) => {
              const isActive = String(selectedLineMeta?.line_id) === String(line.line_id);
              return (
                <span
                  key={line.line_id}
                  role="button"
                  tabIndex={0}
                  className={`mode-badge ${isActive ? 'active' : ''}`}
                  onClick={() => handleLineClick(line)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleLineClick(line);
                    }
                  }}
                >
                  {line.line_name} ({line.mode})
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default LinesAtStop;
