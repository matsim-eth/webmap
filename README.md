## Webmap Link

🔗 [matsim-eth.github.io/webmap](https://matsim-eth.github.io/webmap/)

## Generating Matsim Data for the Webapp

### Overview

To visualize data from MATSim runs onto the webapp, you need to:

1. Run the webmap export stage to generate the necessary outputs.
2. Load the data into the webmap using the "Select Folder" button in the Sidebar

### Prerequisites

- A completed MATSim simulation with the following file outputs
    - MATSim Output Trips
    - MATSim Road Volumes
    - MATSim Network in the [MATSIM Network XML format](https://www.matsim.org/files/dtd/network_v2.dtd)
    - MATSim Transit Schedule
    - MATSim PT Passenger Counts
- Microcensus Inputs for the MATSim simulation
    - Microcensus Trips
    - Mirceocensus Persons
- Swiss Canton Boundaries geojson

## Steps

### Run the Pipeline Stage

Clone the webmap preprocessing stage from [this branch](https://gitlab.ethz.ch/ivt-vpl/populations/ch-zh-synpop/-/tree/webmap-preprocessing)

In particular, `webmap_export.py`, `webmap_export_stage.py`, and `network_reader.py` under "analysis" are required for the preprocessing.

In your pipeline configeration file (`pipeline.yaml`), ensure the `analysis.webmap_export` stage is enabled:

```
run:
    - matsim.simulation.run
    - analysis.webmap_export_stage
```

Once this is complete, the pipeline can be executed.

### Download the Preprocessed Outputs

Once the pipeline has finished, navigate to the cached outputs, under `matsim.simulation.run__[hash].cache/simulation_output/webmap`, download the "data" folder.

### Upload to Webmap

Go to [matsim-eth.github.io/webmap](https://matsim-eth.github.io/webmap/), and on the Sidebar, under "Upload Local Folder" is a button to select a folder. Navigate to the downloaded "data" folder, upload it to the webmap.

Depending on your browser, it may ask if you trust the site to access the folder. Make sure to click "Allow" or "Yes" so the webapp can read the uploaded files correctly.

To test this functionality without running a MATSim simulation, a data sample is provided at this [link](https://polybox.ethz.ch/index.php/s/zJDR3M55P4489nB). Feel free to download this data and try loading it into the webmap.

### Alternatives

Alternatively, if your MATSim outputs are hosted on the web, you can set a Data Source URL to upload the data. For example, if the data is stored under the url 

`https://raw.githubusercontent.com/matsim-eth/webmap/refs/heads/main/public/data/departure_times.json`, 

input `https://raw.githubusercontent.com/matsim-eth/webmap/refs/heads/main/public/data` as the input url.

Please note that this data must be structured in the same way as it is in the pipeline output.

