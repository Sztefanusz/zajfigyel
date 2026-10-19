"""Background collector that polls the public Sensor.Community network and
extracts noise sensor readings located within Budapest.

The upstream payload is a large JSON array of recent (last ~5 min) sensor
measurements from all over the world. We stream-parse it, keep only entries
that (a) sit inside the Budapest bounding box and (b) carry noise values
(value_type starting with "noise_"), then expose the cleaned result through an
in-memory snapshot that the API layer reads.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx

from . import config
from .models import NoiseSensor

logger = logging.getLogger("noise.collector")


class SensorStore:
    """Thread/async-safe-ish in-memory snapshot of the latest readings."""

    def __init__(self) -> None:
        self._sensors: List[NoiseSensor] = []
        self._updated_at: Optional[str] = None
        self._source: str = "sensor.community"
        self._lock = asyncio.Lock()

    async def set(self, sensors: List[NoiseSensor], source: str) -> None:
        async with self._lock:
            self._sensors = sensors
            self._updated_at = datetime.now(timezone.utc).isoformat()
            self._source = source

    async def get(self):
        async with self._lock:
            return list(self._sensors), self._updated_at, self._source


store = SensorStore()


def _to_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _within_budapest(lat: Optional[float], lon: Optional[float]) -> bool:
    if lat is None or lon is None:
        return False
    return (
        config.BUDAPEST_MIN_LAT <= lat <= config.BUDAPEST_MAX_LAT
        and config.BUDAPEST_MIN_LON <= lon <= config.BUDAPEST_MAX_LON
    )


def parse_noise_sensors(payload: list) -> List[NoiseSensor]:
    """Filter the upstream payload down to Budapest noise sensors.

    A sensor can appear multiple times (one entry per sampling); we keep the
    most recent reading per sensor id.
    """
    best: Dict[int, NoiseSensor] = {}

    for entry in payload:
        try:
            location = entry.get("location") or {}
            lat = _to_float(location.get("latitude"))
            lon = _to_float(location.get("longitude"))
            if not _within_budapest(lat, lon):
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
            )

            existing = best.get(reading.sensor_id)
            if existing is None or (reading.timestamp or "") >= (existing.timestamp or ""):
                best[reading.sensor_id] = reading
        except Exception:  # noqa: BLE001 - never let one bad row kill the batch
            logger.debug("Skipping malformed entry", exc_info=True)
            continue

    return list(best.values())


def _demo_sensors() -> List[NoiseSensor]:
    """Synthetic sample used only when no live data is available, so the map is
    never empty during local development or upstream outages."""
    now = datetime.now(timezone.utc).isoformat()
    samples = [
        # (name-ish id, lat, lon, laeq)
        (900001, 47.4979, 19.0402, 62.0),   # Deák Ferenc tér
        (900002, 47.5074, 19.0742, 58.5),   # City Park
        (900003, 47.4812, 19.0569, 71.2),   # Great Market Hall
        (900004, 47.5316, 19.0353, 54.1),   # Óbuda
        (900005, 47.4733, 19.0600, 66.8),   # Boráros tér
        (900006, 47.5186, 19.0783, 49.3),   # Városliget quiet
        (900007, 47.4925, 19.0513, 77.4),   # Astoria junction
        (900008, 47.5401, 19.0691, 52.7),   # Angyalföld
    ]
    out = []
    for sid, lat, lon, laeq in samples:
        out.append(
            NoiseSensor(
                sensor_id=sid,
                location_id=sid,
                latitude=lat,
                longitude=lon,
                noise_laeq=laeq,
                noise_la_max=round(laeq + 8.0, 1),
                noise_la_min=round(laeq - 9.0, 1),
                timestamp=now,
                indoor=False,
            )
        )
    return out


async def fetch_once() -> None:
    """Perform a single poll of the upstream source and update the store."""
    url = config.SENSOR_COMMUNITY_URL
    try:
        async with httpx.AsyncClient(timeout=config.UPSTREAM_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, headers={"User-Agent": "budapest-noise-monitor/1.0"})
            resp.raise_for_status()
            payload = resp.json()
        sensors = parse_noise_sensors(payload)
        if sensors:
            await store.set(sensors, source="sensor.community")
            logger.info("Updated %d Budapest noise sensors from upstream", len(sensors))
            return
        logger.warning("No live Budapest noise sensors found in upstream payload")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Upstream poll failed: %s", exc)

    # Fallback path: keep whatever we had, or seed demo data if empty.
    current, _, _ = await store.get()
    if not current and config.ENABLE_DEMO_FALLBACK:
        await store.set(_demo_sensors(), source="demo")
        logger.info("Seeded demo noise data (no live sensors available)")


async def poll_loop(stop_event: asyncio.Event) -> None:
    """Continuously poll until the stop event is set."""
    while not stop_event.is_set():
        await fetch_once()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=config.POLL_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
