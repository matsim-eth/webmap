import React, { useRef, useState } from 'react';
import './LeftSidebar.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleNodes, faRotateLeft, faFolder, faXmark,
  faChevronLeft, faChevronRight, faChevronDown, faChevronUp,
  faRoad, faPersonWalkingLuggage, faLocationDot, faBus,
  faArrowsSplitUpAndLeft, faChartSimple, faMap, faRoute,
  faRightFromBracket,
  faUserShield,
} from '@fortawesome/free-solid-svg-icons';
import { useFileContext } from '../../FileContext';
import { useApp } from '../../context/AppContext';
import { redirectToLogin, checkIsAdmin } from '../../utils/auth';
import { useQuery } from '@tanstack/react-query';
import DatasetSelector from '../DatasetSelector';

const SectionTitle = ({ label, isOpen, onToggle }) => (
  <button className="left-sidebar-section-title" onClick={onToggle}>
    <span>{label}</span>
    <FontAwesomeIcon icon={isOpen ? faChevronUp : faChevronDown} className="left-sidebar-section-chevron" />
  </button>
);

const LeftSidebar = () => {
  const fileInputRef = useRef(null);

  const [modulesOpen, setModulesOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);

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

  const { data: isAdmin = false } = useQuery({
    queryKey: ['admin-check'],
    queryFn: () => checkIsAdmin(),
  });

  // Expose sidebar width as CSS variable for search bar positioning
  // effect:audited — DOM side-effect syncing CSS custom property to React state
  document.documentElement.style.setProperty(
    '--left-sidebar-width', isCollapsed ? '60px' : '215px'
  );

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

  const handleLogout = async () => {
    try {
      await fetch('/authentification/backend/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch { /* ignore */ }
    redirectToLogin();
  };

  const hasUploadedFiles = fileMap.size > 0;

  return (
    <aside className={`left-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="left-sidebar-content">

        {/* Logout + Reset */}
        <div className="left-sidebar-section">
          <nav className="left-sidebar-nav">
            <button
              className="left-sidebar-item logout-item"
              onClick={handleLogout}
              title={isCollapsed ? 'Sign Out' : ''}
            >
              <span className="left-sidebar-icon"><FontAwesomeIcon icon={faRightFromBracket} /></span>
              {!isCollapsed && <span className="left-sidebar-label">Sign Out</span>}
            </button>

            {isAdmin && (
              <button
                className="left-sidebar-item admin-item"
                onClick={() => window.open('/authentification/admin/?from=webmap', 'admin-tab')}
                title={isCollapsed ? 'Admin Panel' : ''}
              >
                <span className="left-sidebar-icon"><FontAwesomeIcon icon={faUserShield} /></span>
                {!isCollapsed && <span className="left-sidebar-label">Admin</span>}
              </button>
            )}

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
          {!isCollapsed && <SectionTitle label="MODULES" isOpen={modulesOpen} onToggle={() => setModulesOpen(v => !v)} />}
          {(modulesOpen || isCollapsed) && (
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
          )}
        </div>

        {/* DATA Section (dataset + upload) */}
        <div className="left-sidebar-section">
          {!isCollapsed && <SectionTitle label="DATA" isOpen={dataOpen} onToggle={() => setDataOpen(v => !v)} />}
          {(dataOpen || isCollapsed) && (
          <>
          <DatasetSelector isCollapsed={isCollapsed} />
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
          </>
          )}
        </div>

        {/* DASHBOARD Section */}
        <div className="left-sidebar-section">
          <nav className="left-sidebar-nav">
            <button
              className="left-sidebar-item crosslink-item"
              onClick={() => {
                const w = window.open('', 'dashboard-tab');
                if (!w || !w.location.href || w.location.href === 'about:blank') {
                  window.open('/dashboard/', 'dashboard-tab');
                } else {
                  w.focus();
                }
              }}
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
