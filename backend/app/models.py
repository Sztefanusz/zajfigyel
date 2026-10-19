"""Pydantic models describing the data returned by the backend API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class NoiseSensor(BaseModel):
    """A single noise sensor reading within Budapest."""

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


class SensorsResponse(BaseModel):
    """Envelope returned by GET /api/sensors."""

    updated_at: Optional[str] = None
    source: str
    count: int
    center: dict
    bbox: dict
    sensors: List[NoiseSensor]
