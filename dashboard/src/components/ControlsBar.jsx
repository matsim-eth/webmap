import React from 'react';
import './ControlsBar.css';
import { useDashboard } from '../context/DashboardContext';
import cantonAlias from '../utils/canton_alias.json';
import TransitStopSearch from './plots/TransitStopSearch';

const CANTONS = [
  "All", "Aargau", "AppenzellAusserrhoden", "AppenzellInnerrhoden", 
  "Basel-Landschaft", "Basel-Stadt", "Bern", "Fribourg", "Geneve", 
  "Glarus", "Graubunden", "Jura", "Luzern", "Neuchatel", "Nidwalden", 
  "Obwalden", "Schaffhausen", "Schwyz", "Solothurn", "StGallen", 
  "Ticino", "Thurgau", "Uri", "Valais", "Vaud", "Zug", "Zurich"
];

const MODES = [
  { id: "all", label: "All Modes" },
  { id: "bike", label: "Bike" },
  { id: "car", label: "Car" },
  { id: "car_passenger", label: "Car Passenger" },
  { id: "pt", label: "Public Transport" },
  { id: "walk", label: "Walk" },
];

const PURPOSES = [
  { id: "all", label: "All Purposes" },
  { id: "education", label: "Education" },
  { id: "home", label: "Home" },
  { id: "leisure", label: "Leisure" },
  { id: "other", label: "Other" },
  { id: "shop", label: "Shop" },
  { id: "work", label: "Work" },
];

const GENDERS = [
  { id: "male", label: "Male" },
  { id: "female", label: "Female" },
];

const INCOMES = [
  { id: "1", label: "1" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "4", label: "4" },
  { id: "5", label: "5" },
  { id: "6", label: "6" },
  { id: "7", label: "7" },
  { id: "8", label: "8" },
];

const AGES = [
  { id: "[6, 15)", label: "6-14" },
  { id: "[15, 18)", label: "15-17" },
  { id: "[18, 24)", label: "18-23" },
  { id: "[24, 30)", label: "24-29" },
  { id: "[30, 45)", label: "30-44" },
  { id: "[45, 65)", label: "45-64" },
];

const ControlsBar = ({ activeTab }) => {
  const { 
    selectedCanton, setSelectedCanton,
    distanceType, setDistanceType,
    selectedMode, setSelectedMode,
    selectedPurpose, setSelectedPurpose,
    selectedGender, setSelectedGender,
    selectedIncome, setSelectedIncome,
    selectedAge, setSelectedAge
  } = useDashboard();

  // Determine which filters to show based on active tab
  const showModeFilter = activeTab === 'mode';
  const showPurposeFilter = activeTab === 'purpose' || activeTab === 'activities';
  const showDemographicFilters = activeTab === 'pt-subscription';
  const showCarOwnershipFilters = activeTab === 'car-ownership';
  const showDistanceType = activeTab === 'mode' || activeTab === 'purpose';
  const showTransitSearch = activeTab === 'transit-stops';

  return (
    <div className="controls-bar">
      {/* Canton Dropdown */}
      <div className="control-group">
        <label className="control-label">Canton</label>
        <select 
          className="control-select"
          value={selectedCanton}
          onChange={(e) => setSelectedCanton(e.target.value)}
        >
          {CANTONS.map((canton) => (
            <option key={canton} value={canton}>
              {cantonAlias[canton] || canton}
            </option>
          ))}
        </select>
      </div>

      {/* Transit Stop Search - only show on Transit Stops tab */}
      {showTransitSearch && (
        <TransitStopSearch canton={selectedCanton} />
      )}

      {/* Distance Type Toggle - only show on Mode/Purpose tabs */}
      {showDistanceType && (
        <div className="control-group">
          <label className="control-label">Distance Type</label>
          <div className="toggle-group">
            <button 
              className={`toggle-btn ${distanceType === 'euclidean' ? 'active' : ''}`}
              onClick={() => setDistanceType('euclidean')}
            >
              Euclidean
            </button>
            <button 
              className={`toggle-btn ${distanceType === 'network' ? 'active' : ''}`}
              onClick={() => setDistanceType('network')}
            >
              Network
            </button>
          </div>
        </div>
      )}

      {/* Mode Toggle - only show on Mode tab */}
      {showModeFilter && (
        <div className="control-group">
          <label className="control-label">Mode</label>
          <div className="toggle-group mode-toggle">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                className={`toggle-btn ${selectedMode === mode.id ? 'active' : ''}`}
                onClick={() => setSelectedMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Purpose Toggle - only show on Purpose tab */}
      {showPurposeFilter && (
        <div className="control-group">
          <label className="control-label">Purpose</label>
          <div className="toggle-group mode-toggle">
            {PURPOSES.map((purpose) => (
              <button
                key={purpose.id}
                className={`toggle-btn ${selectedPurpose === purpose.id ? 'active' : ''}`}
                onClick={() => setSelectedPurpose(purpose.id)}
              >
                {purpose.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Demographic Filters - only show on PT Subscription tab */}
      {showDemographicFilters && (
        <>
          <div className="control-group">
            <label className="control-label">Gender</label>
            <div className="toggle-group">
              {GENDERS.map((gender) => (
                <button
                  key={gender.id}
                  className={`toggle-btn ${selectedGender === gender.id ? 'active' : ''}`}
                  onClick={() => setSelectedGender(gender.id)}
                >
                  {gender.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Income</label>
            <div className="toggle-group income-toggle">
              {INCOMES.map((income) => (
                <button
                  key={income.id}
                  className={`toggle-btn ${selectedIncome === income.id ? 'active' : ''}`}
                  onClick={() => setSelectedIncome(income.id)}
                >
                  {income.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">Age</label>
            <div className="toggle-group age-toggle">
              {AGES.map((age) => (
                <button
                  key={age.id}
                  className={`toggle-btn ${selectedAge === age.id ? 'active' : ''}`}
                  onClick={() => setSelectedAge(age.id)}
                >
                  {age.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Car Ownership Filters - only show income on Car Ownership tab */}
      {showCarOwnershipFilters && (
        <div className="control-group">
          <label className="control-label">Income</label>
          <div className="toggle-group income-toggle">
            {INCOMES.map((income) => (
              <button
                key={income.id}
                className={`toggle-btn ${selectedIncome === income.id ? 'active' : ''}`}
                onClick={() => setSelectedIncome(income.id)}
              >
                {income.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ControlsBar;
