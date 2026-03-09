"""Data providers for all JSON endpoints.

To add a new endpoint:
  1. Create a new file in this directory, e.g. providers/my_data.py
  2. Subclass DataProvider, set ROUTE = "my_data.json", implement deliver()
  3. Add it to ALL_PROVIDERS below — that's all.

The ROUTE value (not the filename) determines the URL: /data/<ROUTE>.
"""

from .age import AgeProvider
from .gender import GenderProvider
from .departure_times import DepartureTimesProvider
from .car_availability import CarAvailabilityProvider
from .num_cars_age import NumCarsAgeProvider
from .num_cars_gender import NumCarsGenderProvider
from .num_cars_income import NumCarsIncomeProvider
from .pt_subscriptions import PtSubscriptionsProvider
from .pt_sub_age import PtSubAgeProvider
from .pt_sub_gender import PtSubGenderProvider
from .pt_sub_income import PtSubIncomeProvider
from .mode_share import ModeShareProvider
from .purpose_share import PurposeShareProvider
from .avg_dist_data_mode import AvgDistDataModeProvider
from .avg_dist_data_purpose import AvgDistDataPurposeProvider
from .activity_durations import ActivityDurationsProvider
from .num_activities import NumActivitiesProvider
from .out_of_home import OutOfHomeProvider
from .frequent_sequences import FrequentSequencesProvider
from .stacked_bar_euclidean_distance_mode import StackedBarEuclideanDistanceModeProvider
from .stacked_bar_euclidean_distance_purpose import StackedBarEuclideanDistancePurposeProvider
from .stacked_bar_network_distance_mode import StackedBarNetworkDistanceModeProvider
from .stacked_bar_network_distance_purpose import StackedBarNetworkDistancePurposeProvider
from .modes_by_canton import ModesByCantonProvider
from .boarding_data import BoardingDataProvider
from .stop_transfer_data import StopTransferDataProvider
from .tlm_kantonsgebiet_json import TlmKantonsgebietJsonProvider
from .tlm_kantonsgebiet_geojson import TlmKantonsgebietGeojsonProvider

ALL_PROVIDERS = [
    AgeProvider(),
    GenderProvider(),
    DepartureTimesProvider(),
    CarAvailabilityProvider(),
    NumCarsAgeProvider(),
    NumCarsGenderProvider(),
    NumCarsIncomeProvider(),
    PtSubscriptionsProvider(),
    PtSubAgeProvider(),
    PtSubGenderProvider(),
    PtSubIncomeProvider(),
    ModeShareProvider(),
    PurposeShareProvider(),
    AvgDistDataModeProvider(),
    AvgDistDataPurposeProvider(),
    ActivityDurationsProvider(),
    NumActivitiesProvider(),
    OutOfHomeProvider(),
    FrequentSequencesProvider(),
    StackedBarEuclideanDistanceModeProvider(),
    StackedBarEuclideanDistancePurposeProvider(),
    StackedBarNetworkDistanceModeProvider(),
    StackedBarNetworkDistancePurposeProvider(),
    ModesByCantonProvider(),
    BoardingDataProvider(),
    StopTransferDataProvider(),
    TlmKantonsgebietJsonProvider(),
    TlmKantonsgebietGeojsonProvider(),
]
