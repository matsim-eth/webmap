import React from 'react';
import './PlotExpanded.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTimes } from '@fortawesome/free-solid-svg-icons';

const PlotExpanded = ({ isOpen, onClose, expandedComponent }) => {
  if (!isOpen) return null;

  return (
    <div className="plot-expanded-overlay" onClick={onClose}>
      <div className="plot-expanded-content" onClick={(e) => e.stopPropagation()}>
        <button className="plot-expanded-close" onClick={onClose}>
          <FontAwesomeIcon icon={faTimes} />
        </button>
        <div className="plot-expanded-body">
          {expandedComponent && React.createElement(
            expandedComponent.component,
            { sidebarCollapsed: false, isExpanded: true, ...expandedComponent.props }
          )}
        </div>
      </div>
    </div>
  );
};

export default PlotExpanded;