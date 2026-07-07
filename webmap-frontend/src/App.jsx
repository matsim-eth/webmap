import Map from "./components/Map";
import RightSidebar from "./components/sidebar/RightSidebar";
import LeftSidebar from "./components/sidebar/LeftSidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { AppProvider } from "./context/AppContext";
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
  const { setClickedCanton } = useSelection();

  return (
    <>
      <LeftSidebar />
      <CantonSearch onSearch={setClickedCanton} />
      <Map />

      <RightSidebar />

      <NetworkLegend />
    </>
  );
}
export default App;
