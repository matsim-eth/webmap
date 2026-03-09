import { useState, useRef, useEffect } from 'react'
import './App.css'
import Sidebar from './components/Sidebar'
import PlotGrid from './components/PlotGrid'
import ControlsBar from './components/ControlsBar'
import { DashboardProvider, useDashboard } from './context/DashboardContext'
import { FileProvider } from './context/FileContext'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { useFileContext } from './context/FileContext'

window.name = 'dashboard-tab';

function AppContent() {
  const [activeTab, setActiveTab] = useState('mode')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [dataRefreshKey, setDataRefreshKey] = useState(0)
  const mainContentRef = useRef(null)
  const { fileMap } = useFileContext()
  const { setSelectedTransitStop, setSelectedTransitLine } = useDashboard()

  // Refresh plots when files are uploaded/removed (so they use new data)
  useEffect(() => {
    setDataRefreshKey(prev => prev + 1)
  }, [fileMap.size])

  // Clear selected transit stop when leaving transit stops page
  useEffect(() => {
    if (activeTab !== 'transit-stops') {
      setSelectedTransitStop(null)
      setSelectedTransitLine(null)
    }
  }, [activeTab])

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
        setActiveTab={setActiveTab}
        isCollapsed={sidebarCollapsed}
        setIsCollapsed={setSidebarCollapsed}
        onExportImage={exportAsImage}
        onExportPDF={exportAsPDF}
      />
      <main ref={mainContentRef} className={`main-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <ControlsBar activeTab={activeTab} />
        <PlotGrid key={dataRefreshKey} sidebarCollapsed={sidebarCollapsed} activeTab={activeTab} />
      </main>
    </div>
  )
}

function App() {
  return (
    <DashboardProvider>
      <FileProvider>
        <AppContent />
      </FileProvider>
    </DashboardProvider>
  )
}

export default App
