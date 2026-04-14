import React from 'react';

const PlotLoader = () => (
  <div className="plot-loading">
    <div className="plot-loader-wrapper">
      <div className="plot-loader">
        <div className="plot-loader-ring" />
        <div className="plot-loader-ring" />
        <div className="plot-loader-ring" />
      </div>
      <span className="plot-loader-text">Loading...</span>
    </div>
  </div>
);

export default PlotLoader;
