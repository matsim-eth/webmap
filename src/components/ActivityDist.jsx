import React from "react";
import GenericBarPlot from "./GenericBarPlot";
import BasicBarPlot from "./BasicBarPlot";

const ACTIVITY_VARIABLES = {
  "Education": "education",
  "Work": "work",
  "Other": "other",
  "Shop": "shop",
  "Leisure": "leisure",
};

const ActivityDist = ({ canton, onClose, dataURL }) => {
  return (
    <div className="overlay-panel">
      <h3>{canton || "All"} - Activity Distributions</h3>

      <BasicBarPlot
        dataFile="num_activities.json"
        title="Number of Activities Per Day"
        xAxisTitle="Number of Activities"
        yAxisTitle="Proportion"
        canton={canton}
        dataURL={dataURL}
      />

      <BasicBarPlot
        dataFile="frequent_sequences.json"
        title="Frequent Activity Sequences"
        xAxisTitle="Activity Sequence"
        yAxisTitle="Proportion"
        canton={canton}
        dataURL={dataURL}
      />

      <BasicBarPlot
        dataFile="out_of_home.json"
        title="Number of Out of Home Activities"
        xAxisTitle="Number of Activities"
        yAxisTitle="Proportion"
        canton={canton}
        dataURL={dataURL}
      />

      <GenericBarPlot
        dataFile="activity_durations.json"
        title="Activity Duration Distribution"
        xAxisTitle="Duration [HH:mm:ss]"
        variables={ACTIVITY_VARIABLES}
        defaultVariable={ACTIVITY_VARIABLES["Work"]}
        canton={canton}
        dataURL={dataURL}
      />
    </div>
  );
};

export default ActivityDist;
