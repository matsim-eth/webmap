import Map from "./components/Map";
import Sidebar from "./components/Sidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
import { AppProvider, useApp } from "./context/AppContext";
import AuthGate from "./AuthGate";

function App() {
  return (
    <AuthGate>
      <AppProvider>
        <MainContent />
      </AppProvider>
    </AuthGate>
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
