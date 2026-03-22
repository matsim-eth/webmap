    import React, { useRef, useState } from 'react';
    import './Sidebar.css';
    import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
    import { faHouse, faIdCard, faCar, faTrain, faRoad, faBriefcase, faClipboardList, faLocationDot, faImage, faFilePdf, faChevronLeft, faChevronRight, faFolder, faXmark, faSpinner, faCheck, faMap, faRightFromBracket, faUserShield } from '@fortawesome/free-solid-svg-icons';
    import { useFileContext } from '../context/FileContext';
    import { redirectToLogin, checkIsAdmin } from '../utils/auth';
    import { useQuery } from '@tanstack/react-query';

    const Sidebar = ({ activeTab, setActiveTab, isCollapsed, setIsCollapsed, onExportImage, onExportPDF }) => {
    const fileInputRef = useRef(null);

    // state for export status
    const [exportingType, setExportingType] = useState(null); // 'image' or 'pdf' while exporting
    const [exportSuccess, setExportSuccess] = useState(null); // 'image' or 'pdf' after successful export

    // get functions and state from FileContext
    const { handleFolderUpload, fileMap, clearFileMap } = useFileContext();

    const { data: isAdmin = false } = useQuery({
      queryKey: ['isAdmin'],
      queryFn: () => checkIsAdmin(),
      staleTime: Infinity,
    });

    const menuItems = [
        //{ id: 'home', label: 'Home', icon: faHouse },
        { id: 'mode', label: 'Mode', icon: faRoad },
        { id: 'purpose', label: 'Purpose', icon: faBriefcase },
        { id: 'activities', label: 'Activities', icon: faClipboardList },
        { id: 'pt-subscription', label: 'PT Subscription', icon: faTrain },
        { id: 'car-ownership', label: 'Car Ownership', icon: faCar },
        { id: 'demographics', label: 'Demographics', icon: faIdCard },
        { id: 'transit-stops', label: 'Transit Stops', icon: faLocationDot },
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
            
            // Show success checkmark for 2 seconds
            setExportingType(null);
            setExportSuccess(type);
            setTimeout(() => setExportSuccess(null), 2000);
        } catch (error) {
            console.error('Export error:', error);
            setExportingType(null);
        }
    };

    // "Clicks" fileInputRef to open file dialog
    const handleUploadClick = () => {
        fileInputRef.current?.click(); 
    };

    // Triggers when files are selected
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
        <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>

        <div className="sidebar-content">
        {/* Sign out + Admin */}
        <div className="sidebar-section">
            <nav className="sidebar-nav">
                <button
                    className="sidebar-item logout-item"
                    onClick={handleLogout}
                    title={isCollapsed ? 'Sign out' : ''}
                >
                    <span className="sidebar-icon"><FontAwesomeIcon icon={faRightFromBracket} /></span>
                    <span className="sidebar-label">Sign out</span>
                </button>
                {isAdmin && (
                    <button
                        className="sidebar-item admin-item"
                        onClick={() => window.open('/authentification/admin/', '_blank')}
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
            <span className="sidebar-section-title">MENU</span>
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
        </div>

        {/* Upload Section */}

        <div className="sidebar-section">
            <span className="sidebar-section-title">UPLOAD</span>
            <nav className="sidebar-nav">
            <button
                className={`sidebar-item ${hasUploadedFiles ? 'uploaded' : ''}`}
                onClick={handleUploadClick}
                title={isCollapsed ? 'Local Folder' : ''}
            >
                <span className="sidebar-icon"><FontAwesomeIcon icon={faFolder} /></span>
                <span className="sidebar-label">Local Folder</span>
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
            <div className="sidebar-file-count-container">
                <span className="sidebar-file-count">{fileMap.size} files uploaded</span>
                <button
                className="sidebar-file-reset"
                onClick={clearFileMap}
                title="Reset to default data"
                >
                <FontAwesomeIcon icon={faXmark} />
                </button>
            </div>
            )}
        </div>

        {/* Export Section */}
        <div className="sidebar-section">
            <span className="sidebar-section-title">EXPORT</span>
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
        </div>

        <div className="sidebar-section">
            <span className="sidebar-section-title">WEBMAP</span>
            <nav className="sidebar-nav">
                <button
                    className="sidebar-item"
                    onClick={() => window.open('/webmap/', 'webmap-tab')}
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
