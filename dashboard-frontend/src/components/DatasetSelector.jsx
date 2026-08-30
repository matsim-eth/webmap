import React, { useState, useRef, useCallback, useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDatabase, faSpinner, faTimes, faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useDatasets } from '../hooks/useDatasets';
import { useDashboard } from '../context/DashboardContext';
import { studyAreaQueryOptions, areStudyAreasCompatible } from '../hooks/useStudyArea';
import useClickOutside from '../hooks/useClickOutside';
import useFloatingPanelPosition from '../hooks/useFloatingPanelPosition';
import './DatasetSelector.css';

const COLOR_PRESETS = [
  "#4A90E2", "#E07A5F", "#8dd3c7",
  "#ffffb3", "#bebada", "#fdb462",
  "#b3de69", "#fccde5", "#d9d9d9",
];

/** Capitalise a folder name for display (e.g. "synthetic" → "Synthetic"). */
const displayName = (cat) => cat.charAt(0).toUpperCase() + cat.slice(1);

const DatasetSelector = ({ isCollapsed }) => {
  const { comparisonSlots, setSlot, setSlotColor, removeSlot } = useDashboard();
  const { data: datasets = [], isLoading } = useDatasets();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [colorPickerSlotIdx, setColorPickerSlotIdx] = useState(null);
  const [manualCollapsed, setManualCollapsed] = useState({});
  const [slotError, setSlotError] = useState(null);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  const panelStyle = useFloatingPanelPosition(
    panelRef,
    buttonRef,
    isOpen,
    isCollapsed ? 60 : 200
  );

  const activeDatasets = datasets.filter((d) => d.status === 'active');

  // Dataset IDs that have at least one assigned sub-dataset
  const assignedDatasetIds = useMemo(
    () => new Set(comparisonSlots.map((s) => s.datasetId)),
    [comparisonSlots]
  );

  useClickOutside(wrapperRef, () => {
    setIsOpen(false);
    setColorPickerSlotIdx(null);
    setSlotError(null);
  });

  const getSlotIndex = (datasetId, subDataset) =>
    comparisonSlots.findIndex(
      (s) => s && s.datasetId === datasetId && s.subDataset === subDataset
    );

  const pickUniqueColor = (excludeIndex) => {
    const usedColors = comparisonSlots
      .filter((_, i) => i !== excludeIndex)
      .map((s) => s.color);
    return COLOR_PRESETS.find((c) => !usedColors.includes(c)) || COLOR_PRESETS[0];
  };

  const handleSubDatasetClick = useCallback(async (dataset, subDataset) => {
    const existingIdx = comparisonSlots.findIndex(
      (s) => s && s.datasetId === dataset.id && s.subDataset === subDataset
    );

    if (existingIdx >= 0) {
      setSlotError(null);
      removeSlot(existingIdx);
      return;
    }

    const targetIdx = comparisonSlots.length < 2 ? comparisonSlots.length : 1;

    // Geography gate: comparing datasets only makes sense when their zone
    // sets match (same `?canton=` names resolve to the same places in both).
    // Check against whichever OTHER slot would remain in the comparison.
    const other = comparisonSlots.find(
      (s, i) => s && i !== targetIdx && s.datasetId !== dataset.id
    );
    if (other) {
      const [a, b] = await Promise.all([
        queryClient.fetchQuery(studyAreaQueryOptions(other.datasetId)),
        queryClient.fetchQuery(studyAreaQueryOptions(dataset.id)),
      ]);
      if (!areStudyAreasCompatible(a?.studyArea, b?.studyArea)) {
        const describe = (sa) =>
          `${sa?.name || '?'} (${(sa?.zone_label_plural || 'zones').toLowerCase()})`;
        setSlotError(
          `“${dataset.name}” covers ${describe(b?.studyArea)} while ` +
          `“${other.datasetName}” covers ${describe(a?.studyArea)}. `
          + 'Datasets with different zone geographies can’t be compared, pick another one.'
        );
        return;
      }
    }
    setSlotError(null);

    setSlot(targetIdx, {
      datasetId: dataset.id,
      datasetName: dataset.name,
      subDataset,
      color: pickUniqueColor(targetIdx),
    });
  }, [comparisonSlots, setSlot, removeSlot, queryClient]);

  const toggleCollapse = useCallback((dsId) => {
    setManualCollapsed((prev) => {
      // Determine current expanded state using the same logic as isExpanded
      const currentlyExpanded = dsId in prev
        ? !prev[dsId]
        : assignedDatasetIds.has(dsId);
      // Store the inverse so isExpanded (!value) gives the toggled state
      return { ...prev, [dsId]: currentlyExpanded };
    });
  }, [assignedDatasetIds]);

  // A dataset is expanded if: it has an assigned sub-dataset (default open)
  // OR user manually toggled it. manualCollapsed tracks explicit user toggles.
  const isExpanded = (dsId) => {
    if (dsId in manualCollapsed) return !manualCollapsed[dsId];
    return assignedDatasetIds.has(dsId); // auto-expand if has assigned slot
  };

  return (
    <div className="dataset-selector-wrapper" ref={wrapperRef}>
      <button
        ref={buttonRef}
        className={`sidebar-item dataset-item ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
        title={isCollapsed ? 'Dataset' : ''}
      >
        <span className="sidebar-icon">
          <FontAwesomeIcon icon={isLoading ? faSpinner : faDatabase} spin={isLoading} />
        </span>
        <span className="sidebar-label">Dataset</span>
      </button>

      {isOpen && (
        <div
          className="dataset-panel"
          ref={panelRef}
          style={panelStyle || { left: isCollapsed ? 60 : 200 }}
        >
          <div className="dataset-panel-header">Compare Datasets (max 2)</div>

          {slotError && (
            <div className="dataset-panel-error" role="alert">{slotError}</div>
          )}

          {/* Active slots summary */}
          <div className="dataset-panel-slots">
            {comparisonSlots.length === 0 && (
              <div className="dataset-panel-slot-empty">Select sub-datasets below</div>
            )}
            {comparisonSlots.map((slot, idx) => (
              <div key={idx} className="dataset-panel-slot">
                <button
                  className="dataset-slot-color"
                  style={{ backgroundColor: slot.color }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setColorPickerSlotIdx(colorPickerSlotIdx === idx ? null : idx);
                  }}
                  title="Change color"
                />
                <span className="dataset-slot-label">{slot.fullLabel}</span>
                <button
                  className="dataset-slot-remove"
                  onClick={() => { setSlotError(null); removeSlot(idx); }}
                  title="Remove"
                >
                  <FontAwesomeIcon icon={faTimes} />
                </button>

                {colorPickerSlotIdx === idx && (
                  <div className="dataset-color-picker" onClick={(e) => e.stopPropagation()}>
                    {COLOR_PRESETS.map((c) => (
                      <button
                        key={c}
                        className={`dataset-color-swatch ${slot.color === c ? 'active' : ''}`}
                        style={{ backgroundColor: c }}
                        onClick={() => {
                          setSlotColor(idx, c);
                          setColorPickerSlotIdx(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Dataset list — collapsible per dataset */}
          <div className="dataset-panel-list">
            {activeDatasets.length === 0 && (
              <div className="dataset-panel-empty">No active datasets</div>
            )}
            {activeDatasets.map((ds) => {
              const expanded = isExpanded(ds.id);
              return (
                <div key={ds.id} className="dataset-group">
                  <button
                    className="dataset-group-header"
                    onClick={() => toggleCollapse(ds.id)}
                  >
                    <FontAwesomeIcon
                      icon={expanded ? faChevronDown : faChevronRight}
                      className="dataset-group-chevron"
                    />
                    <span className="dataset-group-name">{ds.name}</span>
                    {ds.is_public && <span className="dataset-panel-badge">public</span>}
                  </button>

                  {expanded && (
                    <div className="dataset-sub-list">
                      {(ds.data_categories || []).map((cat) => {
                        const sub = displayName(cat);
                        const slotIdx = getSlotIndex(ds.id, sub);
                        const isAssigned = slotIdx >= 0;
                        const slotColor = isAssigned ? comparisonSlots[slotIdx]?.color : null;

                        return (
                          <button
                            key={sub}
                            className={`dataset-sub-item ${isAssigned ? 'assigned' : ''}`}
                            onClick={() => handleSubDatasetClick(ds, sub)}
                          >
                            {isAssigned && (
                              <span
                                className="dataset-sub-badge"
                                style={{ backgroundColor: slotColor }}
                              >
                                {slotIdx + 1}
                              </span>
                            )}
                            <span className="dataset-sub-name">
                              {ds.name} - {sub}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default DatasetSelector;
