import React from "react";
import BasicBarPlot from "./BasicBarPlot";

const ACTIVITY_VARIABLES = {
  "Education": "education",
  "Work": "work",
  "Other": "other",
  "Shop": "shop",
  "Leisure": "leisure",
};

const Demographics = ({ canton, onClose, dataURL }) => {
  return (
    <div className="overlay-panel">
      <h3>{canton || "All"} - Activity Distributions</h3>

      <BasicBarPlot
        dataFile="age.json"
        title="Age Group Distribution"
        xAxisTitle="Age Group"
        yAxisTitle="Proportion"
        canton={canton}
        dataURL={dataURL}
      />

      <BasicBarPlot
        dataFile="gender.json"
        title="Gender Distribution"
        xAxisTitle="Gender"
        yAxisTitle="Proportion"
        canton={canton}
        dataURL={dataURL}
      />
    </div>
  );
};

export default Demographics;
