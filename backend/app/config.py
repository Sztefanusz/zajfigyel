"""Application configuration, read from environment variables with sane defaults."""
import os


def _get_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _get_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Upstream public data source (Sensor.Community global sensor network).
# This endpoint returns 5-minute averages for every active sensor worldwide.
SENSOR_COMMUNITY_URL = os.environ.get(
    "SENSOR_COMMUNITY_URL",
    "https://data.sensor.community/static/v2/data.json",
)

# How often (seconds) the backend polls the upstream source.
POLL_INTERVAL_SECONDS = _get_int("POLL_INTERVAL_SECONDS", 120)

# HTTP timeout for the upstream request (the payload is large).
UPSTREAM_TIMEOUT_SECONDS = _get_int("UPSTREAM_TIMEOUT_SECONDS", 60)

# Geocoding service (OpenStreetMap Nominatim) used to turn a typed location
# into coordinates. Usage policy requires a descriptive User-Agent.
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
GEOCODER_USER_AGENT = os.environ.get("GEOCODER_USER_AGENT", "noise-monitor/2.0 (public demo)")

# Default radius (km) when querying by an arbitrary location.
DEFAULT_RADIUS_KM = _get_float("DEFAULT_RADIUS_KM", 5.0)
MAX_RADIUS_KM = _get_float("MAX_RADIUS_KM", 50.0)

# Default city shown on first load.
DEFAULT_CITY = os.environ.get("DEFAULT_CITY", "budapest")


# Predefined major cities. Each entry: display name, map centre, default zoom,
# and a bounding box (min_lat, min_lon, max_lat, max_lon) used for filtering.
CITIES = {
    "budapest": {
        "name": "Budapest",
        "country": "HU",
        "center": {"lat": 47.4979, "lon": 19.0402},
        "zoom": 12,
        "bbox": {"min_lat": 47.35, "min_lon": 18.92, "max_lat": 47.61, "max_lon": 19.33},
    },
    "berlin": {
        "name": "Berlin",
        "country": "DE",
        "center": {"lat": 52.5200, "lon": 13.4050},
        "zoom": 11,
        "bbox": {"min_lat": 52.34, "min_lon": 13.09, "max_lat": 52.68, "max_lon": 13.76},
    },
    "stuttgart": {
        "name": "Stuttgart",
        "country": "DE",
        "center": {"lat": 48.7758, "lon": 9.1829},
        "zoom": 12,
        "bbox": {"min_lat": 48.69, "min_lon": 9.04, "max_lat": 48.87, "max_lon": 9.32},
    },
    "london": {
        "name": "London",
        "country": "GB",
        "center": {"lat": 51.5074, "lon": -0.1278},
        "zoom": 11,
        "bbox": {"min_lat": 51.28, "min_lon": -0.52, "max_lat": 51.70, "max_lon": 0.33},
    },
    "paris": {
        "name": "Paris",
        "country": "FR",
        "center": {"lat": 48.8566, "lon": 2.3522},
        "zoom": 12,
        "bbox": {"min_lat": 48.78, "min_lon": 2.19, "max_lat": 48.93, "max_lon": 2.52},
    },
    "amsterdam": {
        "name": "Amsterdam",
        "country": "NL",
        "center": {"lat": 52.3676, "lon": 4.9041},
        "zoom": 12,
        "bbox": {"min_lat": 52.29, "min_lon": 4.73, "max_lat": 52.43, "max_lon": 5.07},
    },
    "vienna": {
        "name": "Vienna",
        "country": "AT",
        "center": {"lat": 48.2082, "lon": 16.3738},
        "zoom": 12,
        "bbox": {"min_lat": 48.11, "min_lon": 16.18, "max_lat": 48.32, "max_lon": 16.58},
    },
    "sofia": {
        "name": "Sofia",
        "country": "BG",
        "center": {"lat": 42.6977, "lon": 23.3219},
        "zoom": 12,
        "bbox": {"min_lat": 42.60, "min_lon": 23.19, "max_lat": 42.78, "max_lon": 23.45},
    },
}
