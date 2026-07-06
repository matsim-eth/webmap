import React, { useCallback, useMemo, useRef, useState } from 'react';
import './TransitStopSearch.css';
import { useData } from '../../context/DataContext';
import { useDashboard } from '../../context/DashboardContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import useClickOutside from '../../hooks/useClickOutside';
import {
  toLineList,
  isModeFilterActive,
  buildSelectedLineMeta,
} from '../../utils/transitLineFilter';

const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const cmpByLineName = (a, b) =>
  String(a.line_name || '').localeCompare(String(b.line_name || ''), undefined, { numeric: true });

const TransitLineSearch = () => {
  const { getData } = useData();
  const {
    selectedLineMeta,
    setSelectedLineMeta,
    setSelectedMunicipality,
    setLineWithCanton,
    selectedLineModes,
    selectedCanton,
  } = useDashboard();

  const [searchTerm, setSearchTerm] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(-1);
  // Hide the dropdown after a selection (until the user types again).
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);
  useClickOutside(wrapperRef, useCallback(() => setIsOpen(false), []));

  // Debounce only the dropdown filter — the input value is still bound to
  // `searchTerm` so typing feels instant. 120ms is short enough that the
  // gap is barely perceptible but coalesces fast typing into one filter pass.
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 120);

  const raw = getData('boarding_data_by_line.json');
  // Pre-normalize once per load. Previously each keystroke renormalized N
  // line names + ids; now keystrokes only walk the cached list. For ~10k
  // Switzerland-wide lines this drops per-keystroke work from O(N) string
  // ops to O(N) compares.
  const indexedLines = useMemo(
    () =>
      toLineList(raw).map((l) => ({
        line: l,
        name: normalize(l.line_name),
        id: normalize(l.line_id),
      })),
    [raw]
  );

  // Filter against a given query. Extracted so the Enter handler can compute
  // on the live `searchTerm` if the debounce hasn't caught up yet (otherwise
  // a fast typer pressing Enter would drop into a stale list).
  const cantonActive = selectedCanton && selectedCanton !== 'All';

  const computeFiltered = useCallback((query) => {
    if (!query.trim()) return [];
    const q = normalize(query);
    const modesActive = isModeFilterActive(selectedLineModes);

    const startsWith = [];
    const contains = [];
    for (const entry of indexedLines) {
      if (modesActive && !selectedLineModes.includes(String(entry.line.vehicle))) continue;
      // Canton filter: restrict to lines that serve the selected canton. Lines
      // with an empty/unknown `cantons` array are non-catalog (near-zero
      // volume) — exclude them so the list only shows lines actually in view.
      if (cantonActive) {
        const cantons = Array.isArray(entry.line.cantons) ? entry.line.cantons : [];
        if (!cantons.includes(selectedCanton)) continue;
      }
      if (entry.name.startsWith(q) || entry.id.startsWith(q)) {
        startsWith.push(entry.line);
      } else if (entry.name.includes(q) || entry.id.includes(q)) {
        contains.push(entry.line);
      }
    }
    return [...startsWith.sort(cmpByLineName), ...contains.sort(cmpByLineName)].slice(0, 10);
  }, [indexedLines, selectedLineModes, cantonActive, selectedCanton]);

  const filteredLines = useMemo(
    () => computeFiltered(debouncedSearchTerm),
    [computeFiltered, debouncedSearchTerm]
  );

  const handleSelect = (line) => {
    if (!line) return;
    // Sync canton selection to the line's geography:
    //   - single-canton line → switch to that canton (so the user sees its
    //     stops on transit-stops-layer instead of as inter-cantonal stops)
    //   - multi-canton line → keep the current canton when the line serves it
    //     (preserves the canton filter context the user just searched within);
    //     otherwise reset to "All" so the whole route is in view
    // setLineWithCanton sets both atomically — using setSelectedCanton +
    // setSelectedLineMeta separately would race because the canton's
    // cascading setSelectedLineMeta(null) gets queued for the next render
    // and clobbers the line we just set.
    const cantonsForLine = Array.isArray(line.cantons) ? line.cantons : [];
    let targetCanton;
    if (cantonsForLine.length === 1) {
      targetCanton = cantonsForLine[0];
    } else if (cantonActive && cantonsForLine.includes(selectedCanton)) {
      targetCanton = selectedCanton;
    } else {
      targetCanton = 'All';
    }
    setLineWithCanton(buildSelectedLineMeta(line), targetCanton);
    setSearchTerm('');
    setHighlightIdx(-1);
    setIsOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filteredLines.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Prefer the dropdown's current top hit; if the debounce hasn't caught
      // up yet, compute on the live searchTerm so Enter never drops into a
      // stale list.
      const liveList = filteredLines.length ? filteredLines : computeFiltered(searchTerm);
      const target = highlightIdx >= 0 ? liveList[highlightIdx] : liveList[0];
      if (target) handleSelect(target);
    } else if (e.key === 'Escape') {
      setSearchTerm('');
      setHighlightIdx(-1);
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    setSelectedLineMeta(null);
    setSelectedMunicipality(null);
    setSearchTerm('');
    setHighlightIdx(-1);
    setIsOpen(false);
  };

  const isLoading = raw === null;

  return (
    <div className="transit-stop-search-inline">
      <label className="control-label">Search Line</label>
      <div className="search-wrapper" ref={wrapperRef}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setHighlightIdx(-1);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={isLoading ? 'Loading...' : 'Type a line name (e.g. S1, IC1)'}
          className="transit-stop-input-inline"
          disabled={isLoading}
        />

        {isOpen && filteredLines.length > 0 && (
          <ul className="transit-stop-dropdown">
            {cantonActive && (
              <li
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--color-text-secondary)',
                  cursor: 'default',
                  fontStyle: 'italic',
                }}
              >
                Showing lines in {selectedCanton}
              </li>
            )}
            {filteredLines.map((line, i) => (
              <li
                key={`${line.line_id}_${line.line_name}_${i}`}
                onClick={() => handleSelect(line)}
                className={i === highlightIdx ? 'selected' : ''}
              >
                <div className="stop-name">
                  {line.line_name || line.line_id}{' '}
                  <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>
                    ({line.vehicle || 'unknown'})
                  </span>
                </div>
                <div className="stop-modes">
                  {Array.isArray(line.cantons) ? line.cantons.join(', ') : ''}
                  {line.line_id ? ` — ${line.line_id}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedLineMeta && (
        <button
          type="button"
          onClick={handleClear}
          className="toggle-btn"
          title="Clear selection"
        >
          Clear
        </button>
      )}
    </div>
  );
};

export default TransitLineSearch;
