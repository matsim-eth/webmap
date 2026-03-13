import Map from "./components/Map";
import RightSidebar from "./components/sidebar/RightSidebar";
import LeftSidebar from "./components/sidebar/LeftSidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
import { AppProvider, useApp } from "./context/AppContext";

window.name = 'webmap-tab';

function App() {
  return (
    <AppProvider>
      <MainContent />
    </AppProvider>
  );
}

function MainContent() {
  const { dataURL, mapRef, setClickedCanton } = useApp();

  return (
    <FileProvider dataURL={dataURL}>
      <LeftSidebar />
      <CantonSearch
        map={mapRef.current}
        onSearch={setClickedCanton}
      />
      <Map />

      <RightSidebar />

      <NetworkLegend />
    </FileProvider>
  );
}
export default App;
