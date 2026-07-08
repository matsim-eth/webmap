import React, { useState, useRef, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDatabase, faCheck, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { useDatasets } from '../hooks/useDatasets';
import { useData } from '../context/DataContext';
import useClickOutside from '../hooks/useClickOutside';
import { useFullReset } from '../hooks/useFullReset';
import './DatasetSelector.css';

const DatasetSelector = ({ isCollapsed }) => {
  const { datasetId, setDatasetId } = useData();
  const { data: datasets = [], isLoading } = useDatasets();
  const fullReset = useFullReset();
  const [isOpen, setIsOpen] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  const activeDatasets = datasets.filter((d) => d.status === 'active');
  const currentDataset = activeDatasets.find((d) => d.id === datasetId);

  useClickOutside(wrapperRef, () => setIsOpen(false));

  const handleSelect = useCallback((id) => {
    if (id !== datasetId) {
      setDatasetId(id);
      // A dataset switch behaves exactly like the Reset button: no module
      // state, selections or choropleth from the previous dataset survive.
      fullReset();
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1000);
    }
    setIsOpen(false);
  }, [setDatasetId, datasetId, fullReset]);

  const getPanelStyle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return { left: isCollapsed ? 60 : 215, top: 80 };
    return {
      left: isCollapsed ? 60 : 215,
      top: rect.top,
    };
  };

  return (
    <div className="dataset-selector-wrapper" ref={wrapperRef}>
      <button
        ref={buttonRef}
        className={`left-sidebar-item dataset-item ${isOpen ? 'active' : ''} ${showSuccess ? 'dataset-success' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
        title={isCollapsed ? 'Dataset' : ''}
      >
        <span className="left-sidebar-icon">
          <FontAwesomeIcon icon={isLoading ? faSpinner : showSuccess ? faCheck : faDatabase} spin={isLoading} />
        </span>
        {!isCollapsed && <span className="left-sidebar-label">{showSuccess ? 'Dataset Changed' : 'Dataset'}</span>}
      </button>

      {isOpen && (
        <div className="dataset-panel" style={getPanelStyle()}>
          <div className="dataset-panel-header">Select Dataset</div>
          <div className="dataset-panel-list">
            {activeDatasets.length === 0 && (
              <div className="dataset-panel-empty">No active datasets</div>
            )}
            {activeDatasets.map((ds) => (
              <button
                key={ds.id}
                className={`dataset-panel-item ${ds.id === datasetId ? 'selected' : ''}`}
                onClick={() => handleSelect(ds.id)}
              >
                <span className="dataset-panel-item-name">{ds.name}</span>
                {ds.is_public && <span className="dataset-panel-badge">public</span>}
                {ds.id === datasetId && (
                  <span className="dataset-panel-check">
                    <FontAwesomeIcon icon={faCheck} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default DatasetSelector;
