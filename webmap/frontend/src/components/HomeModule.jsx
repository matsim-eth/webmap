import React from "react";

const HomeModule = ({
  inputURL,
  setInputURL,
  setDataURL,
  activeDatasetId,
  setActiveDatasetId,
  selectedAggCol,
  setSelectedAggCol,
  fileMap,
  fileInputRef,
  handleFolderUpload
}) => {
  return (
    <div className="home-message">
      <p>Select a canton and a visualization to get started!</p>

      {/* Dataset ID selector */}
      <div className="mode-filter-container">
        <label className="mode-filter-label">Dataset ID:</label>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
          <input
            type="number"
            min="1"
            value={activeDatasetId ?? ""}
            onChange={(e) => {
              const id = parseInt(e.target.value, 10);
              if (!isNaN(id) && id > 0) {
                setActiveDatasetId(id);
              }
            }}
            placeholder="1000000001"
            className="mode-filter-select url-input"
            style={{ height: "28px", width: "140px" }}
          />
          <button
            className="graph-button"
            style={{ width: "fit-content" }}
            onClick={async () => {
              const id = activeDatasetId || 1000000001;
              const baseURL = `/webmap/backend/data/${id}/`;
              try {
                const response = await fetch(`${baseURL}modes_by_canton.json`);
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                await response.json();
                alert("Dataset loaded successfully.");
                setDataURL(baseURL);
              } catch (error) {
                alert("Failed to load dataset. Check that the ID is valid and you have access.");
                console.error("Dataset load error:", error);
              }
            }}
          >
            Load
          </button>
        </div>
      </div>

      {/* Data URL (advanced override) */}
      <div className="mode-filter-container">
        <label className="mode-filter-label">Custom Data URL (advanced):</label>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
          <input
            type="text"
            value={inputURL}
            onChange={(e) => setInputURL(e.target.value)}
            placeholder="/webmap/backend/data/1000000001/"
            className="mode-filter-select url-input"
            style={{ height: "28px" }}
          />
          <button
            className="graph-button"
            style={{ width: "fit-content" }}
            onClick={async () => {
              let trimmed = inputURL.trim();
              if (!trimmed) {
                trimmed = `/webmap/backend/data/${activeDatasetId || 1000000001}/`;
              }
              if (!trimmed.endsWith("/")) trimmed += "/";

              try {
                const response = await fetch(`${trimmed}modes_by_canton.json`);
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                await response.json();
                alert("Data loaded successfully from the provided URL.");
                setDataURL(trimmed);
              } catch (error) {
                alert("Failed to load data from the provided URL.\nPlease ensure the URL is correct and accessible.");
                console.error("Data source error:", error);
              }
            }}
          >
            Set
          </button>
        </div>
      </div>

      {/* Upload Folder */}
      <input
        type="file"
        webkitdirectory="true"
        directory=""
        multiple
        ref={fileInputRef}
        onChange={(e) => handleFolderUpload(e.target.files)}
        style={{ display: "none" }}
      />
      <div className="mode-filter-container">
        <label className="mode-filter-label">Upload Local Folder</label>
        <button
          className="graph-button"
          onClick={() => fileInputRef.current?.click()}
        >
          📁 Select Folder
        </button>
        <p style={{ fontSize: "12px", color: "#555", marginTop: "6px", marginLeft: "6px" }}>
          {fileMap.size > 0
            ? `${fileMap.size} files uploaded`
            : "Upload files to override default data"}
        </p>
      </div>

      {/* AggCol Selector */}
      <div className="mode-filter-container">
        <label className="mode-filter-label">Group Graphs By:</label>
        <select
          multiple
          value={[selectedAggCol]}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map(opt => opt.value);
            if (selected.length > 0) {
              setSelectedAggCol(selected[selected.length - 1]);
            }
          }}
          className="mode-filter-select"
        >
          <option value="mode">Mode</option>
          <option value="purpose">Purpose</option>
        </select>
      </div>
    </div>
  );
};

export default HomeModule;
