"""Data providers for all JSON endpoints.

To add a new endpoint:
  1. Create a new file in this directory, e.g. providers/my_data.py
  2. Subclass DataProvider, set ROUTE = "my_data.json", implement deliver()
  3. Add it to ALL_PROVIDERS below — that's all.

The ROUTE value (not the filename) determines the URL: /data/<ROUTE>.
"""

# --- Existing providers ---
from .age import AgeProvider
from .gender import GenderProvider
from .departure_times import DepartureTimesProvider
from .car_availability import CarAvailabilityProvider

# --- Consolidated providers ---
from .num_cars import NumCarsProvider
from .pt_sub import PtSubProvider
from .avg_distance import AvgDistanceProvider
from .histogram_distance import HistogramDistanceProvider
from .lineplot import LineplotProvider
from .stacked_bar_distance import StackedBarDistanceProvider
from .tlm_kantonsgebiet import TlmKantonsgebietProvider

# --- Trip-based providers ---
from .mode_share import ModeShareProvider
from .purpose_share import PurposeShareProvider

# --- Activity-based providers ---
from .activity_durations import ActivityDurationsProvider
from .num_activities import NumActivitiesProvider
from .out_of_home import OutOfHomeProvider
from .frequent_sequences import FrequentSequencesProvider

# --- Special providers ---
from .modes_by_canton import ModesByCantonProvider
from .boarding_data import BoardingDataProvider
from .stop_transfer_data import StopTransferDataProvider
from .stop_municipality import StopMunicipalityProvider
from .municipalities import MunicipalitiesProvider

# --- Spider analysis ---
from .spider_analysis import SpiderInflowProvider, SpiderOutflowProvider, SpiderOverlayProvider
from .node_flows import NodeFlowsProvider
from .nodes_geojson import NodesGeoJSONProvider
from .zone_flows import ZoneFlowsProvider

# --- Link speeds ---
from .link_speeds import LinkSpeedsProvider, SpeedDashboardProvider

ALL_PROVIDERS = [
    # Demographics
    AgeProvider(),
    GenderProvider(),
    CarAvailabilityProvider(),
    # Departure times
    DepartureTimesProvider(),
    # Number of cars (consolidated: ?breakdown=age/gender/income)
    NumCarsProvider(),
    # PT subscriptions (consolidated: ?breakdown=overall/age/gender/income)
    PtSubProvider(),
    # Trip-based
    ModeShareProvider(),
    PurposeShareProvider(),
    # Average distance (consolidated: ?group_by=mode/purpose)
    AvgDistanceProvider(),
    # Activity-based
    ActivityDurationsProvider(),
    NumActivitiesProvider(),
    OutOfHomeProvider(),
    FrequentSequencesProvider(),
    # Histogram (consolidated: ?distance_type=euclidean/network&group_by=mode/purpose)
    HistogramDistanceProvider(),
    # Lineplot (consolidated: ?metric=departure_time/euclidean_distance/network_distance&group_by=mode/purpose)
    LineplotProvider(),
    # Stacked bar (consolidated: ?distance_type=euclidean/network&group_by=mode/purpose)
    StackedBarDistanceProvider(),
    # Special
    ModesByCantonProvider(),
    BoardingDataProvider(),
    StopTransferDataProvider(),
    StopMunicipalityProvider(),
    MunicipalitiesProvider(),
    # Geographic (consolidated: ?format=geojson/json)
    TlmKantonsgebietProvider(),
    # Spider analysis
    SpiderInflowProvider(),
    SpiderOutflowProvider(),
    SpiderOverlayProvider(),
    # Node flows (turning-movement matrix)
    NodeFlowsProvider(),
    # Nodes GeoJSON (per-canton point features)
    NodesGeoJSONProvider(),
    # Zone flows (OD canton flows)
    ZoneFlowsProvider(),
    # Link speeds
    LinkSpeedsProvider(),
    SpeedDashboardProvider(),
]
