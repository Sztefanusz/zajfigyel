"""Background collector that polls the public Sensor.Community network and
keeps the latest worldwide noise sensor readings in memory.

The upstream payload is a large JSON array of recent (last ~5 min) sensor
measurements from all over the world. We stream-parse it, keep only entries
that carry noise values (value_type starting with "noise_"), and expose the
cleaned result through an in-memory snapshot. Per-request filtering by city
bounding box or by a location + radius happens in the API layer using the
helpers here.

If the upstream source is unavailable or returns no noise data, the store is
simply empty — we never fabricate data. The API then reports "no data".
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx

from . import config
from .models import NoiseSensor

logger = logging.getLogger("noise.collector")


class SensorStore:
    """Async-safe in-memory snapshot of the latest worldwide noise readings."""

    def __init__(self) -> None:
        self._sensors: List[NoiseSensor] = []
        self._updated_at: Optional[str] = None
        self._last_poll_ok: bool = False
        self._lock = asyncio.Lock()

    async def set(self, sensors: List[NoiseSensor], ok: bool) -> None:
        async with self._lock:
            self._sensors = sensors
            self._updated_at = datetime.now(timezone.utc).isoformat()
            self._last_poll_ok = ok

    async def get(self):
        async with self._lock:
            return list(self._sensors), self._updated_at, self._last_poll_ok


store = SensorStore()


def _to_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_noise_sensors(payload: list) -> List[NoiseSensor]:
    """Filter the upstream payload down to all worldwide noise sensors.

    A sensor can appear multiple times (one entry per sampling); we keep the
    most recent reading per sensor id.
    """
    best: Dict[int, NoiseSensor] = {}

    for entry in payload:
        try:
            location = entry.get("location") or {}
            lat = _to_float(location.get("latitude"))
            lon = _to_float(location.get("longitude"))
            if lat is None or lon is None:
                continue

            values = entry.get("sensordatavalues") or []
            noise: Dict[str, float] = {}
            for v in values:
                vtype = v.get("value_type", "")
                if vtype.startswith("noise_"):
                    parsed = _to_float(v.get("value"))
                    if parsed is not None:
                        noise[vtype] = parsed

            # Skip non-noise sensors (dust/temp/humidity/etc.).
            if not noise:
                continue

            sensor_info = entry.get("sensor") or {}
            sensor_id = sensor_info.get("id")
            if sensor_id is None:
                continue

            reading = NoiseSensor(
                sensor_id=int(sensor_id),
                location_id=int(location.get("id") or 0),
                latitude=lat,
                longitude=lon,
                noise_laeq=noise.get("noise_LAeq"),
                noise_la_max=noise.get("noise_LA_max"),
                noise_la_min=noise.get("noise_LA_min"),
                timestamp=entry.get("timestamp"),
                indoor=bool(location.get("indoor")),
                country=(location.get("country") or None),
            )

            existing = best.get(reading.sensor_id)
            if existing is None or (reading.timestamp or "") >= (existing.timestamp or ""):
                best[reading.sensor_id] = reading
        except Exception:  # noqa: BLE001 - never let one bad row kill the batch
            logger.debug("Skipping malformed entry", exc_info=True)
            continue

    return list(best.values())


def filter_bbox(sensors: List[NoiseSensor], bbox: dict) -> List[NoiseSensor]:
    """Keep sensors inside a bounding box dict with min/max lat/lon."""
    return [
        s
        for s in sensors
        if bbox["min_lat"] <= s.latitude <= bbox["max_lat"]
        and bbox["min_lon"] <= s.longitude <= bbox["max_lon"]
    ]


def filter_radius(
    sensors: List[NoiseSensor], lat: float, lon: float, radius_km: float
) -> List[NoiseSensor]:
    """Keep sensors within radius_km of (lat, lon), annotating distance."""
    out: List[NoiseSensor] = []
    for s in sensors:
        d = haversine_km(lat, lon, s.latitude, s.longitude)
        if d <= radius_km:
            s_copy = s.model_copy(update={"distance_km": round(d, 2)})
            out.append(s_copy)
    out.sort(key=lambda s: (s.distance_km if s.distance_km is not None else 1e9))
    return out


async def fetch_once() -> bool:
    """Perform a single poll of the upstream source and update the store.

    Returns True when the poll succeeded (even if there were zero noise
    sensors worldwide, which would be unusual). On failure the previous
    snapshot is preserved and False is returned.
    """
    url = config.SENSOR_COMMUNITY_URL
    try:
        async with httpx.AsyncClient(timeout=config.UPSTREAM_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers={"User-Agent": "noise-monitor/2.0"})
            resp.raise_for_status()
            payload = resp.json()
        sensors = parse_noise_sensors(payload)
        await store.set(sensors, ok=True)
        logger.info("Updated %d worldwide noise sensors from upstream", len(sensors))
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Upstream poll failed: %s", exc)
        # Keep whatever we already had; mark the poll as not-ok.
        current, _, _ = await store.get()
        await store.set(current, ok=False)
        return False


async def poll_loop(stop_event: asyncio.Event) -> None:
    """Continuously poll until the stop event is set."""
    while not stop_event.is_set():
        await fetch_once()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=config.POLL_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
