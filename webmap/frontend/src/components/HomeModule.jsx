import React from "react";

const HomeModule = ({
  inputURL,
  setInputURL,
  setDataURL,
  fileMap,
  fileInputRef,
  handleFolderUpload
}) => {
  return (
    <div className="home-message">
      <p>Select a canton and a visualization to get started!</p>

      {/* Data URL */}
      <div className="mode-filter-container">
        <label className="mode-filter-label">Data Source URL:</label>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
          <input
            type="text"
            value={inputURL}
            onChange={(e) => setInputURL(e.target.value)}
            placeholder="https://matsim-eth.github.io/webmap/data/"
            className="mode-filter-select url-input"
            style={{ height: "28px" }}
          />
          <button
            className="graph-button"
            style={{ width: "fit-content" }}
            onClick={async () => {
              let trimmed = inputURL.trim() || "https://matsim-eth.github.io/webmap/data/";
              if (!trimmed.endsWith("/")) trimmed += "/";

              try {
                const response = await fetch(`${trimmed}modes_by_canton.json`);
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                await response.json();
                alert("Data loaded successfully from the provided URL.");
                setDataURL(trimmed);
              } catch (error) {
                alert("Failed to load data from the provided URL.\nPlease ensure the URL is correct and accessible.");
                setDataURL("https://matsim-eth.github.io/webmap/data/");
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

      {/* Dashboard Link */}
      <p style={{ fontSize: "14px", marginTop: "16px", marginLeft: "6px" }}>
        <span>To view plots: </span>
        <a
          href="https://matsim-eth.github.io/dashboard/"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontWeight: "bold", color: "#1a73e8" }}
        >
          Open Dashboard
        </a>
      </p>
    </div>
  );
};

export default HomeModule;