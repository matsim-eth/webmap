import { useState, useEffect, useRef } from "react";
import Map from "./components/Map";
import Sidebar from "./components/Sidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";

function App() {

  const [dataURL, setDataURL] = useState("https://matsim-eth.github.io/webmap/data/");
  
  const [clickedCanton, setClickedCanton] = useState(null); // Store clicked canton

  const [isSidebarOpen, setIsSidebarOpen] = useState(true); // Tracks if the sidebar is open or collapsed (hidden)
  const [isGraphExpanded, setIsGraphExpanded] = useState(false); // Tracks the current module on the Sidebar

  // CantonList for search
  const [cantonList, setCantonList] = useState([]);

  // Choropleth Symbology
  const [selectedMode, setSelectedMode] = useState("None"); // by default, show no mode (transparent purple background)
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // by default, show Microcensus
  
  // Intialize reference to store Mapbox instance
  const mapRef = useRef(null);

  // Matsim network modes (MatSIM network module)
  const [selectedNetworkModes, setSelectedNetworkModes] = useState(["all"]);

  // Save selected network segment properties
  const [selectedNetworkFeature, setSelectedNetworkFeature] = useState(null);

  // Pass selected link id to map (for ant-path visualization)
  const [visualizeLinkId, setVisualizeLinkId] = useState(null);

  // Pass selected transit mode / stop to map
  const [selectedTransitModes, setSelectedTransitModes] = useState(["all"]);
  const [selectedTransitStop, setSelectedTransitStop] = useState(null);

  // Pass selected transit line to map
  const [highlightedLineId, setHighlightedLineId] = useState(null);
  const [highlightedRouteIds, setHighlightedRouteIds] = useState([]);

  // Read cantons
  useEffect(() => {
    fetch('/data/TLM_KANTONSGEBIET.geojson')
    .then(response => response.json())
    .then(data => {
      setCantonList(data.features.map(f => f.properties.NAME));
    })
    .catch(error => console.error("Error fetching cantons:", error));
  }, []);
  
  // Pass selected mode/dataset from sidebar to map
  const updateMapSymbology = (mode, dataset) => {
    setSelectedMode(mode);
    setSelectedDataset(dataset);
  };

  // Handle map reset if button clicked in sidebar
  const resetMapView = () => {
    // Reset selected canton
    if (mapRef.current.getLayer("selected-canton-border")) {
      mapRef.current.setFilter("selected-canton-border", ["==", "NAME", ""]);
    }

    // Remove network layers
    if (mapRef.current.getLayer("network-layer")) {
      mapRef.current.removeLayer("network-layer");
      mapRef.current.removeLayer("click-network-layer");
    }

    if (mapRef.current.getLayer("network-highlight")) {
      mapRef.current.removeLayer("network-highlight");
    }

    if (mapRef.current.getLayer("ant-line")) {
      mapRef.current.removeLayer("ant-line");
    }

    // Reset selected network, 
    setSelectedNetworkFeature(null)
    setVisualizeLinkId(null)

    // Reset to map center
    mapRef.current.easeTo({
      center: [8.1642, 46.7592], // Initial coordinates
      zoom: 7, // Initial zoom level
      duration: 1000, // Smooth transition
    });
  };

 return (
  <>
    <CantonSearch
      map={mapRef.current}
      cantonList={cantonList} // from app
      onSearch={setClickedCanton} // to map
    />

    <Map 
      mapRef={mapRef} // from app
      setClickedCanton={setClickedCanton} // to sidebar
      isSidebarOpen={isSidebarOpen} // from sidebar
      isGraphExpanded={isGraphExpanded} // from sidebar
      searchCanton={clickedCanton} // from canton search
      selectedMode={selectedMode} // from sidebar
      selectedDataset={selectedDataset} // from sidebar
      selectedNetworkModes={selectedNetworkModes}  // from sidebar
      setSelectedNetworkFeature={setSelectedNetworkFeature} // to sidebar
      visualizeLinkId={visualizeLinkId} // from segment vol histogram via sidebar
      setVisualizeLinkId={setVisualizeLinkId} // from sidebar
      dataURL={dataURL} // from Sidebar
      selectedTransitModes={selectedTransitModes} // from sidebar
      setSelectedTransitStop={setSelectedTransitStop} // to sidebar
      highlightedLineId={highlightedLineId}
      setHighlightedLineId={setHighlightedLineId}
      highlightedRouteIds={highlightedRouteIds}
      setHighlightedRouteIds = {setHighlightedRouteIds}
    />

    <Sidebar
      mapRef={mapRef} //from app
      canton={clickedCanton} // from map
      isOpen={isSidebarOpen} // to map
      toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} // to map
      onExpandGraph={setIsGraphExpanded} // to map
      setCanton={setClickedCanton} // from map
      resetMapView={resetMapView} // to app
      updateMapSymbology={updateMapSymbology} // to map
      selectedNetworkModes={selectedNetworkModes} // to map
      setSelectedNetworkModes={setSelectedNetworkModes} // to change value
      selectedNetworkFeature={selectedNetworkFeature} // from map
      setVisualizeLinkId={setVisualizeLinkId} // to map
      dataURL={dataURL}
      setDataURL={setDataURL}
      selectedTransitModes={selectedTransitModes}
      setSelectedTransitModes={setSelectedTransitModes} 
      selectedTransitStop={selectedTransitStop}
      highlightedLineId={highlightedLineId}
      setHighlightedLineId={setHighlightedLineId}
      setHighlightedRouteIds = {setHighlightedRouteIds}
    />

    <NetworkLegend
      selectedGraph={isGraphExpanded} // from sidebar
    />
  </>
);
}

export default App;
