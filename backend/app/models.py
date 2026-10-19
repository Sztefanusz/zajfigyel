"""Pydantic models describing the data returned by the backend API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class NoiseSensor(BaseModel):
    """A single noise sensor reading."""

    sensor_id: int
    location_id: int
    latitude: float
    longitude: float
    # Equivalent continuous sound level (A-weighted), the primary metric.
    noise_laeq: Optional[float] = None
    noise_la_max: Optional[float] = None
    noise_la_min: Optional[float] = None
    timestamp: Optional[str] = None
    indoor: bool = False
    country: Optional[str] = None
    # Distance from the query point (only set for radius queries).
    distance_km: Optional[float] = None


class Area(BaseModel):
    """Describes the geographic area a sensor query covers."""

    # "city" or "radius"
    mode: str
    label: Optional[str] = None
    center: dict
    zoom: Optional[int] = None
    bbox: Optional[dict] = None
    radius_km: Optional[float] = None


class SensorsResponse(BaseModel):
    """Envelope returned by the sensor query endpoints."""

    updated_at: Optional[str] = None
    # True when the latest upstream poll succeeded.
    data_available: bool
    # True when the upstream poll worked but no sensors matched the area.
    upstream_ok: bool
    count: int
    area: Area
    sensors: List[NoiseSensor]


class City(BaseModel):
    """A predefined major city option for the switcher."""

    id: str
    name: str
    country: Optional[str] = None
    center: dict
    zoom: int
    bbox: dict


class GeocodeResult(BaseModel):
    display_name: str
    lat: float
    lon: float
