import Map from "./components/Map";
import Sidebar from "./components/Sidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
import { AppProvider, useApp } from "./context/AppContext";

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
      <CantonSearch
        map={mapRef.current}
        onSearch={setClickedCanton}
      />

      <Map />

      <Sidebar />

      <NetworkLegend />
    </FileProvider>
  );
}

export default App;
