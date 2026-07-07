    import React, { useState } from 'react';
    import './Sidebar.css';
    import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
    import { faHouse, faIdCard, faCar, faTrain, faTrainSubway, faRoad, faBriefcase, faClipboardList, faLocationDot, faImage, faFilePdf, faChevronLeft, faChevronRight, faChevronDown, faChevronUp, faSpinner, faCheck, faMap, faRightFromBracket, faUserShield, faGaugeHigh } from '@fortawesome/free-solid-svg-icons';
    import { redirectToLogin, checkIsAdmin } from '../utils/auth';
    import { useQuery } from '@tanstack/react-query';
    import DatasetSelector from './DatasetSelector';

    const SectionTitle = ({ label, isOpen, onToggle, isCollapsed }) => {
      if (isCollapsed) return null;
      return (
        <button className="sidebar-section-title" onClick={onToggle}>
          <span>{label}</span>
          <FontAwesomeIcon icon={isOpen ? faChevronUp : faChevronDown} className="sidebar-section-chevron" />
        </button>
      );
    };

    const Sidebar = ({ activeTab, setActiveTab, isCollapsed, setIsCollapsed, onExportImage, onExportPDF }) => {
    const [menuOpen, setMenuOpen] = useState(true);
    const [dataOpen, setDataOpen] = useState(true);
    const [exportOpen, setExportOpen] = useState(true);

    // state for export status
    const [exportingType, setExportingType] = useState(null);
    const [exportSuccess, setExportSuccess] = useState(null);

    const { data: isAdmin = false } = useQuery({
      queryKey: ['isAdmin'],
      queryFn: () => checkIsAdmin(),
      staleTime: Infinity,
    });

    const menuItems = [
        { id: 'mode', label: 'Mode', icon: faRoad },
        { id: 'purpose', label: 'Purpose', icon: faBriefcase },
        { id: 'activities', label: 'Activities', icon: faClipboardList },
        { id: 'pt-subscription', label: 'PT Subscription', icon: faTrain },
        { id: 'car-ownership', label: 'Car Ownership', icon: faCar },
        { id: 'demographics', label: 'Demographics', icon: faIdCard },
        { id: 'speed', label: 'Speed', icon: faGaugeHigh },
        { id: 'transit-stops', label: 'Transit Stops', icon: faLocationDot },
        { id: 'transit-lines', label: 'Transit Lines', icon: faTrainSubway },
    ];

    const exportItems = [
        { id: 'image', label: 'Image', icon: faImage },
        { id: 'pdf', label: 'PDF', icon: faFilePdf },
    ];

    const handleExport = async (type) => {
        setExportingType(type);
        setExportSuccess(null);

        try {
            if (type === 'image' && onExportImage) {
                await onExportImage();
            } else if (type === 'pdf' && onExportPDF) {
                await onExportPDF();
            }

            setExportingType(null);
            setExportSuccess(type);
            setTimeout(() => setExportSuccess(null), 2000);
        } catch (error) {
            console.error('Export error:', error);
            setExportingType(null);
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

    return (
        <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>

        <div className="sidebar-content">
        {/* Sign Out + Admin */}
        <div className="sidebar-section">
            <nav className="sidebar-nav">
                <button
                    className="sidebar-item logout-item"
                    onClick={handleLogout}
                    title={isCollapsed ? 'Sign Out' : ''}
                >
                    <span className="sidebar-icon"><FontAwesomeIcon icon={faRightFromBracket} /></span>
                    <span className="sidebar-label">Sign Out</span>
                </button>
                {isAdmin && (
                    <button
                        className="sidebar-item admin-item"
                        onClick={() => window.open('/authentification/admin/?from=dashboard', 'admin-tab')}
                        title={isCollapsed ? 'Admin Panel' : ''}
                    >
                        <span className="sidebar-icon"><FontAwesomeIcon icon={faUserShield} /></span>
                        <span className="sidebar-label">Admin</span>
                    </button>
                )}
            </nav>
        </div>

        {/* Menu Section */}
        <div className="sidebar-section">
            <SectionTitle label="MENU" isOpen={menuOpen} onToggle={() => setMenuOpen(v => !v)} isCollapsed={isCollapsed} />
            {(menuOpen || isCollapsed) && (
            <nav className="sidebar-nav">
            {menuItems.map((item) => (
                <button
                key={item.id}
                className={`sidebar-item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => setActiveTab(item.id)}
                title={isCollapsed ? item.label : ''}
                >
                <span className="sidebar-icon"><FontAwesomeIcon icon={item.icon} /></span>
                <span className="sidebar-label">{item.label}</span>
                </button>
            ))}
            </nav>
            )}
        </div>

        {/* Data Section (dataset selector) */}
        <div className="sidebar-section">
            <SectionTitle label="DATA" isOpen={dataOpen} onToggle={() => setDataOpen(v => !v)} isCollapsed={isCollapsed} />
            {(dataOpen || isCollapsed) && (
            <DatasetSelector isCollapsed={isCollapsed} />
            )}
        </div>

        {/* Export Section */}
        <div className="sidebar-section">
            <SectionTitle label="EXPORT" isOpen={exportOpen} onToggle={() => setExportOpen(v => !v)} isCollapsed={isCollapsed} />
            {(exportOpen || isCollapsed) && (
            <nav className="sidebar-nav">
            {exportItems.map((item) => {
                const isExporting = exportingType === item.id;
                const isSuccess = exportSuccess === item.id;
                const icon = isExporting ? faSpinner : isSuccess ? faCheck : item.icon;
                const label = isExporting ? 'Exporting...' : item.label;

                return (
                    <button
                    key={item.id}
                    className={`sidebar-item ${isSuccess ? 'export-success' : ''}`}
                    onClick={() => handleExport(item.id)}
                    disabled={exportingType !== null}
                    title={isCollapsed ? label : ''}
                    >
                    <span className="sidebar-icon">
                        <FontAwesomeIcon icon={icon} spin={isExporting} />
                    </span>
                    <span className="sidebar-label">{label}</span>
                    </button>
                );
            })}
            </nav>
            )}
        </div>

        <div className="sidebar-section">
            <nav className="sidebar-nav">
                <button
                    className="sidebar-item crosslink-item"
                    onClick={() => {
                      const w = window.open('', 'webmap-tab');
                      if (!w || !w.location.href || w.location.href === 'about:blank') {
                        window.open('/webmap/', 'webmap-tab');
                      } else {
                        w.focus();
                      }
                    }}
                    title={isCollapsed ? "Open Webmap" : ""}
                >
                    <span className="sidebar-icon"><FontAwesomeIcon icon={faMap} /></span>
                    <span className="sidebar-label">Open Webmap</span>
                </button>
            </nav>
        </div>
        </div>

    {/* Collapse/Expand Button */}
        <button
            className="sidebar-toggle"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
            <FontAwesomeIcon icon={isCollapsed ? faChevronRight : faChevronLeft} />
        </button>
        </aside>
    );
};

export default Sidebar;
