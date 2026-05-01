import Map from "./components/Map";
import RightSidebar from "./components/sidebar/RightSidebar";
import LeftSidebar from "./components/sidebar/LeftSidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
import { AppProvider } from "./context/AppContext";
import { useData } from "./context/DataContext";
import { useMap } from "./context/MapContext";
import { useSelection } from "./context/SelectionContext";

window.name = 'webmap-tab';

function App() {
  return (
    <AppProvider>
      <MainContent />
    </AppProvider>
  );
}

function MainContent() {
  const { dataURL } = useData();
  const { mapRef } = useMap();
  const { setClickedCanton } = useSelection();

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
