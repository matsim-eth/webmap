import Map from "./components/Map";
import RightSidebar from "./components/sidebar/RightSidebar";
import LeftSidebar from "./components/sidebar/LeftSidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
import { AppProvider } from "./context/AppContext";
import { useData } from "./context/DataContext";
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
  const { setClickedCanton } = useSelection();

  return (
    <FileProvider dataURL={dataURL}>
      <LeftSidebar />
      <CantonSearch onSearch={setClickedCanton} />
      <Map />

      <RightSidebar />

      <NetworkLegend />
    </FileProvider>
  );
}
export default App;
