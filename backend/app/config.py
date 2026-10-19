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

# Budapest bounding box. Measurements outside this box are ignored.
# Roughly covers the administrative area of Budapest plus near suburbs.
BUDAPEST_MIN_LAT = _get_float("BUDAPEST_MIN_LAT", 47.35)
BUDAPEST_MAX_LAT = _get_float("BUDAPEST_MAX_LAT", 47.61)
BUDAPEST_MIN_LON = _get_float("BUDAPEST_MIN_LON", 18.92)
BUDAPEST_MAX_LON = _get_float("BUDAPEST_MAX_LON", 19.33)

# Map centre used by the frontend.
BUDAPEST_CENTER_LAT = _get_float("BUDAPEST_CENTER_LAT", 47.4979)
BUDAPEST_CENTER_LON = _get_float("BUDAPEST_CENTER_LON", 19.0402)

# When no live Budapest noise sensors are reachable, fall back to a small
# synthetic sample so the UI is never empty. Controlled by env var.
ENABLE_DEMO_FALLBACK = os.environ.get("ENABLE_DEMO_FALLBACK", "true").lower() in (
    "1",
    "true",
    "yes",
)
