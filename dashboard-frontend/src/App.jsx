import { useState, useRef } from 'react'
import './App.css'
import Sidebar from './components/Sidebar'
import PlotGrid from './components/PlotGrid'
import ControlsBar from './components/ControlsBar'
import { DashboardProvider, useDashboard } from './context/DashboardContext'
import { useAutoInitSlots } from './hooks/useAutoInitSlots'
import { DataProvider } from './context/DataContext'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
window.name = 'dashboard-tab';

function AppContent() {
  const [activeTab, setActiveTab] = useState('mode')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const mainContentRef = useRef(null)
  const { setSelectedTransitStop, setSelectedTransitLine, setSelectedLineMeta, setSelectedMunicipality } = useDashboard()

  // Auto-populate comparison slots with first dataset on initial load
  useAutoInitSlots()

  const handleSetActiveTab = (tab) => {
    // Clear selected transit stop when leaving transit stops page
    if (tab !== 'transit-stops' && activeTab === 'transit-stops') {
      setSelectedTransitStop(null)
      setSelectedTransitLine(null)
    }
    // Clear selected transit line when leaving transit-lines page
    if (tab !== 'transit-lines' && activeTab === 'transit-lines') {
      setSelectedLineMeta(null)
      setSelectedMunicipality(null)
      setSelectedTransitStop(null)
    }
    // Clear stop when arriving at transit-lines from elsewhere — the
    // tab uses click-on-canton-then-stop as its primary entry point.
    if (tab === 'transit-lines' && activeTab !== 'transit-lines') {
      setSelectedTransitStop(null)
    }
    setActiveTab(tab)
  }

  const exportAsImage = async () => {
    if (!mainContentRef.current) return
    
    try {
      // Small delay to ensure map canvas is ready
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const canvas = await html2canvas(mainContentRef.current, {
        backgroundColor: '#f3f4f6',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      })
      
      const link = document.createElement('a')
      link.download = `dashboard-${activeTab}-${new Date().toISOString().slice(0,10)}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (error) {
      console.error('Error exporting image:', error)
    }
  }

  const exportAsPDF = async () => {
    if (!mainContentRef.current) return
    
    try {
      // Small delay to ensure map canvas is ready
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const canvas = await html2canvas(mainContentRef.current, {
        backgroundColor: '#f3f4f6',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      })
      
      const imgData = canvas.toDataURL('image/png')
      const imgWidth = canvas.width
      const imgHeight = canvas.height
      
      // Create PDF in landscape if wider than tall
      const isLandscape = imgWidth > imgHeight
      const pdf = new jsPDF({
        orientation: isLandscape ? 'landscape' : 'portrait',
        unit: 'px',
        format: [imgWidth / 2, imgHeight / 2]
      })
      
      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth / 2, imgHeight / 2)
      pdf.save(`dashboard-${activeTab}-${new Date().toISOString().slice(0,10)}.pdf`)
    } catch (error) {
      console.error('Error exporting PDF:', error)
    }
  }

  return (
    <div className="app-container">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleSetActiveTab}
        isCollapsed={sidebarCollapsed}
        setIsCollapsed={setSidebarCollapsed}
        onExportImage={exportAsImage}
        onExportPDF={exportAsPDF}
      />
      <main ref={mainContentRef} className={`main-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <ControlsBar activeTab={activeTab} />
        <PlotGrid sidebarCollapsed={sidebarCollapsed} activeTab={activeTab} />
      </main>
    </div>
  )
}

function App() {
  return (
    <DashboardProvider>
      <DataProvider>
        <AppContent />
      </DataProvider>
    </DashboardProvider>
  )
}

export default App
