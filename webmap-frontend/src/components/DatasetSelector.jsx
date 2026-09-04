import React, { useState, useRef, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDatabase, faCheck, faSpinner, faFlask } from '@fortawesome/free-solid-svg-icons';
import { useDatasets } from '../hooks/useDatasets';
import { useData } from '../context/DataContext';
import useClickOutside from '../hooks/useClickOutside';
import { useFullReset } from '../hooks/useFullReset';
import { ACTIVE, STATUS_LABEL, jobStage, useSimJobs } from './SimJobsModal';
import './DatasetSelector.css';

// Runs that are not (yet) a dataset but belong in this list: everything in
// flight, plus interrupted runs the user can still resume.
const LISTED = new Set([...ACTIVE, 'failed', 'cancelled']);

const DatasetSelector = ({ isCollapsed, onOpenSimulations }) => {
  const { datasetId, setDatasetId } = useData();
  const { data: datasets = [], isLoading } = useDatasets();
  const { available: simAvailable, jobs } = useSimJobs(20000);
  const fullReset = useFullReset();
  const [isOpen, setIsOpen] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  const activeDatasets = datasets.filter((d) => d.status === 'active');
  // Finished runs ARE datasets — tag them so the origin is visible.
  const simResultIds = new Set(jobs.filter((j) => j.status === 'done' && j.result_dataset_id)
    .map((j) => j.result_dataset_id));
  const resumedIds = new Set(jobs.map((j) => j.resume_of).filter(Boolean));
  const simRows = simAvailable
    ? jobs.filter((j) => LISTED.has(j.status) && !resumedIds.has(j.job_id)).slice(0, 5)
    : [];

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
    const left = isCollapsed ? 60 : 215;
    if (!rect) return { left, top: 80 };
    const itemHeight = 43;
    const headerHeight = 40;
    const listPadding = 8;
    const rows = Math.min(activeDatasets.length, 5) + (simRows.length ? simRows.length + 1 : 0);
    const panelHeight = headerHeight + listPadding + rows * itemHeight;
    const top = Math.min(rect.top, window.innerHeight - panelHeight - 4);
    return {
      left,
      top: Math.max(8, top),
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
                title={ds.description || ''}
              >
                <span className="dataset-panel-item-name">{ds.name}</span>
                {simResultIds.has(ds.id) && (
                  <span className="dataset-panel-badge sim" title="result of a custom simulation run">
                    <FontAwesomeIcon icon={faFlask} /> sim
                  </span>
                )}
                {ds.is_public && <span className="dataset-panel-badge">public</span>}
                {ds.id === datasetId && (
                  <span className="dataset-panel-check">
                    <FontAwesomeIcon icon={faCheck} />
                  </span>
                )}
              </button>
            ))}

            {simRows.length > 0 && (
              <>
                <div className="dataset-panel-section">Simulations</div>
                {simRows.map((j) => {
                  const pct = Math.round((j.progress || 0) * 100);
                  const running = j.status === 'running' || j.status === 'uploading';
                  return (
                    <button
                      key={`sim-${j.job_id}`}
                      className={`dataset-panel-item dataset-panel-sim ${j.status}`}
                      onClick={() => { setIsOpen(false); onOpenSimulations?.(); }}
                      title={`${j.description || j.title}\n${jobStage(j)}`}
                    >
                      <span className="dataset-panel-sim-main">
                        <span className="dataset-panel-item-name">
                          <FontAwesomeIcon icon={faFlask} /> {j.title}
                        </span>
                        <span className="dataset-panel-sim-stage">{jobStage(j)}</span>
                        {running && (
                          <span className="dataset-panel-sim-bar">
                            <span style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </span>
                      <span className={`dataset-panel-badge sim-status ${j.status}`}>
                        {STATUS_LABEL[j.status] || j.status}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DatasetSelector;
