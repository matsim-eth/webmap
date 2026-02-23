import React, { useRef, useEffect } from 'react';
import './LeftSidebar.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleNodes, faRotateLeft, faFolder, faXmark,
  faChevronLeft, faChevronRight,
  faRoad, faPersonWalkingLuggage, faLocationDot, faBus, faTicket,
  faArrowsSplitUpAndLeft, faChartSimple, faMap, faRoute
} from '@fortawesome/free-solid-svg-icons';
import { useFileContext } from '../FileContext';
import { useApp } from '../context/AppContext';

const LeftSidebar = () => {
  const fileInputRef = useRef(null);

  const {
    isGraphExpanded, setIsGraphExpanded,
    setIsSidebarOpen,
    setIsFeatureTableOpen,
    setHighlightedLineId, setHighlightedRouteIds,
    setSelectedNetworkModes,
    setResetMapTrigger,
    setSelectedDataset, setSelectedMode,
    setSelectedTransitModes,
    updateMapChoropleth,
    resetMapView,
    setDataURL,
    isLeftSidebarCollapsed: isCollapsed,
    setIsLeftSidebarCollapsed: setIsCollapsed,
  } = useApp();

  const { handleFolderUpload, fileMap, clearFileMap } = useFileContext();

  // Expose sidebar width as CSS variable for search bar positioning
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--left-sidebar-width', isCollapsed ? '60px' : '215px'
    );
  }, [isCollapsed]);

  const menuItems = [
    { id: 'Choropleth', label: 'Choropleth', icon: faMap },
    { id: 'Network', label: 'MATSim Network', icon: faCircleNodes },
    { id: 'Volumes', label: 'Road Volumes', icon: faRoad },
    { id: 'Transit', label: 'Transit Stops', icon: faBus},
    { id: 'TransitVolumes', label: 'Transit Volumes', icon: faRoute },
    { id: 'Destination', label: 'Destination Zones', icon: faLocationDot },
    { id: 'PtBoardings', label: 'PT Boardings', icon: faPersonWalkingLuggage },
    { id: 'VolumeFlow', label: 'Volume Flow', icon: faArrowsSplitUpAndLeft },
  ];

  const handleModuleSelect = (moduleId) => {
    setIsFeatureTableOpen(false);

    // Clear transit selection when leaving Transit modules
    if (isGraphExpanded === 'Transit' || isGraphExpanded === 'TransitVolumes') {
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);
    }

    setIsGraphExpanded(moduleId);

    // Set default network modes per module
    if (moduleId === 'Volumes') setSelectedNetworkModes(['car']);
    else if (moduleId === 'Network') setSelectedNetworkModes(['all']);
    else setSelectedNetworkModes(['all']);

    // Open the right sidebar and auto-collapse the left sidebar
    setIsSidebarOpen(true);
  };

  const handleReset = () => {
    setResetMapTrigger((prev) => !prev);

    setSelectedDataset('Microcensus');
    setSelectedMode('None');
    setSelectedNetworkModes(['all']);
    setSelectedTransitModes(['all']);
    updateMapChoropleth('None', 'Microcensus');
    resetMapView();

    setHighlightedLineId(null);
    setHighlightedRouteIds([]);

    setIsGraphExpanded(null);

    clearFileMap();
    setDataURL('https://matsim-eth.github.io/webmap/data/');

    setIsSidebarOpen(false);
    setIsCollapsed(true);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFolderUpload(files);
    }
  };

  const hasUploadedFiles = fileMap.size > 0;

  return (
    <aside className={`left-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="left-sidebar-content">

        {/* Reset button */}
        <div className="left-sidebar-section">
          <nav className="left-sidebar-nav">

            <button
              className="left-sidebar-item reset-item"
              onClick={handleReset}
              title={isCollapsed ? 'Reset' : ''}
            >
              <span className="left-sidebar-icon"><FontAwesomeIcon icon={faRotateLeft} /></span>
              {!isCollapsed && <span className="left-sidebar-label">Reset</span>}
            </button>
          </nav>
        </div>

        {/* MODULES Section */}
        <div className="left-sidebar-section">
          {!isCollapsed && <span className="left-sidebar-section-title">MODULES</span>}
          <nav className="left-sidebar-nav">
            {menuItems.map((item) => (
              <button
                key={item.id}
                className={`left-sidebar-item ${isGraphExpanded === item.id ? 'active' : ''}`}
                onClick={() => handleModuleSelect(item.id)}
                title={isCollapsed ? item.label : ''}
              >
                <span className="left-sidebar-icon"><FontAwesomeIcon icon={item.icon} /></span>
                {!isCollapsed && <span className="left-sidebar-label">{item.label}</span>}
              </button>
            ))}
          </nav>
        </div>

        {/* UPLOAD Section */}
        <div className="left-sidebar-section">
          {!isCollapsed && <span className="left-sidebar-section-title">UPLOAD</span>}
          <nav className="left-sidebar-nav">
            <button
              className={`left-sidebar-item ${hasUploadedFiles ? 'uploaded' : ''}`}
              onClick={handleUploadClick}
              title={isCollapsed ? 'Local Folder' : ''}
            >
              <span className="left-sidebar-icon"><FontAwesomeIcon icon={faFolder} /></span>
              {!isCollapsed && <span className="left-sidebar-label">Local Folder</span>}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </nav>
          {!isCollapsed && hasUploadedFiles && (
            <div className="left-sidebar-file-count-container">
              <span className="left-sidebar-file-count">{fileMap.size} files uploaded</span>
              <button
                className="left-sidebar-file-reset"
                onClick={clearFileMap}
                title="Reset to default data"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
          )}
        </div>

        {/* DASHBOARD Section */}
        <div className="left-sidebar-section">
          {!isCollapsed && <span className="left-sidebar-section-title">DASHBOARD</span>}
          <nav className="left-sidebar-nav">
            <button
              className="left-sidebar-item"
              onClick={() => window.open('https://matsim-eth.github.io/dashboard/', '_blank')}
              title={isCollapsed ? 'Open Dashboard' : ''}
            >
              <span className="left-sidebar-icon"><FontAwesomeIcon icon={faChartSimple} /></span>
              {!isCollapsed && <span className="left-sidebar-label">Open Dashboard</span>}
            </button>
          </nav>
        </div>
      </div>

      {/* Collapse/Expand Toggle */}
      <button
        className="left-sidebar-toggle"
        onClick={() => setIsCollapsed(!isCollapsed)}
        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronLeft} />
      </button>
    </aside>
  );
};

export default LeftSidebar;
