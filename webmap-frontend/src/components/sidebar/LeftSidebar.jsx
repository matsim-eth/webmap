import React, { useState } from 'react';
import './LeftSidebar.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleNodes, faRotateLeft,
  faChevronLeft, faChevronRight, faChevronDown, faChevronUp,
  faRoad, faPersonWalkingLuggage, faLocationDot, faBus,
  faArrowsSplitUpAndLeft, faChartSimple, faMap, faRoute,
  faRightFromBracket,
  faUserShield,
  faKey,
  faFlask,
  faArrowsTurnToDots,
  faGaugeHigh,
  faRightLeft,
  faDrawPolygon,
} from '@fortawesome/free-solid-svg-icons';
import { useModule } from '../../context/ModuleContext';
import { useMap } from '../../context/MapContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { useChoropleth } from '../../context/ChoroplethContext';
import { redirectToLogin, checkIsAdmin } from '../../utils/auth';
import { useFullReset } from '../../hooks/useFullReset';
import { useQuery } from '@tanstack/react-query';
import DatasetSelector from '../DatasetSelector';
import ApiTokensModal from '../ApiTokensModal';
import SimJobsModal, { useSimJobsBadge } from '../SimJobsModal';
import { LEFT_SIDEBAR_WIDTH, LEFT_SIDEBAR_COLLAPSED_WIDTH } from './sidebarLayout';

const SectionTitle = ({ label, isOpen, onToggle }) => (
  <button className="left-sidebar-section-title" onClick={onToggle}>
    <span>{label}</span>
    <FontAwesomeIcon icon={isOpen ? faChevronUp : faChevronDown} className="left-sidebar-section-chevron" />
  </button>
);

const LeftSidebar = () => {
  const [modulesOpen, setModulesOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [simJobsOpen, setSimJobsOpen] = useState(false);
  // hidden entirely when the sim service isn't deployed
  const simBadge = useSimJobsBadge();

  const { isGraphExpanded, setIsGraphExpanded } = useModule();
  const {
    setIsSidebarOpen,
    isLeftSidebarCollapsed: isCollapsed,
    setIsLeftSidebarCollapsed: setIsCollapsed,
  } = useMap();
  const { setIsFeatureTableOpen } = useData();
  const { setSelectedNetworkModes } = useFilters();
  const { setHighlightedLineId, setHighlightedRouteIds } = useChoropleth();

  const { data: isAdmin = false } = useQuery({
    queryKey: ['admin-check'],
    queryFn: () => checkIsAdmin(),
  });

  // Expose sidebar width as CSS variable for search bar positioning
  // effect:audited — DOM side-effect syncing CSS custom property to React state
  document.documentElement.style.setProperty(
    '--left-sidebar-width',
    `${isCollapsed ? LEFT_SIDEBAR_COLLAPSED_WIDTH : LEFT_SIDEBAR_WIDTH}px`
  );

  const menuItems = [
    { id: 'Choropleth', label: 'Choropleth', icon: faMap },
    { id: 'Network', label: 'MATSim Network', icon: faCircleNodes },
    { id: 'Volumes', label: 'Road Volumes', icon: faRoad },
    { id: 'Transit', label: 'Transit Stops', icon: faBus},
    { id: 'TransitVolumes', label: 'Transit Volumes', icon: faRoute },
    { id: 'Destination', label: 'Destination Zones', icon: faLocationDot },
    // { id: 'PtBoardings', label: 'PT Boardings', icon: faPersonWalkingLuggage },
    { id: 'VolumeFlow', label: 'Volume Flow', icon: faArrowsSplitUpAndLeft },
    { id: 'NodeFlows', label: 'Node Flows', icon: faArrowsTurnToDots },
    { id: 'LinkSpeeds', label: 'Link Speeds', icon: faGaugeHigh },
    { id: 'ZoneFlows', label: 'Zone Flows', icon: faRightLeft },
    { id: 'PolygonTrips', label: 'Polygon Trips', icon: faDrawPolygon },
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

  const handleReset = useFullReset();

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
              className="left-sidebar-item"
              onClick={() => setTokensOpen(true)}
              title={isCollapsed ? 'API Tokens' : ''}
            >
              <span className="left-sidebar-icon"><FontAwesomeIcon icon={faKey} /></span>
              {!isCollapsed && <span className="left-sidebar-label">API Tokens</span>}
            </button>

            {simBadge.available && (
              <button
                className="left-sidebar-item"
                onClick={() => setSimJobsOpen(true)}
                title={isCollapsed ? 'Simulations' : ''}
              >
                <span className="left-sidebar-icon"><FontAwesomeIcon icon={faFlask} /></span>
                {!isCollapsed && <span className="left-sidebar-label">Simulations</span>}
                {simBadge.activeCount > 0 && (
                  <span className="simjobs-nav-badge">{simBadge.activeCount}</span>
                )}
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

        {/* DATA Section (dataset selector) */}
        <div className="left-sidebar-section">
          {!isCollapsed && <SectionTitle label="DATA" isOpen={dataOpen} onToggle={() => setDataOpen(v => !v)} />}
          {(dataOpen || isCollapsed) && (
            <DatasetSelector
              isCollapsed={isCollapsed}
              onOpenSimulations={simBadge.available ? () => setSimJobsOpen(true) : undefined}
            />
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

      {tokensOpen && <ApiTokensModal onClose={() => setTokensOpen(false)} />}
      {simJobsOpen && <SimJobsModal onClose={() => setSimJobsOpen(false)} />}

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
