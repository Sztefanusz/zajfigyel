"""FastAPI application: serves the noise API and the static frontend."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import collector, config
from .models import Area, City, GeocodeResult, SensorsResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("noise.main")

FRONTEND_DIR = os.environ.get(
    "FRONTEND_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop_event = asyncio.Event()
    task = asyncio.create_task(collector.poll_loop(stop_event))
    logger.info("Started noise collector (poll interval %ss)", config.POLL_INTERVAL_SECONDS)
    try:
        yield
    finally:
        stop_event.set()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        logger.info("Stopped noise collector")


app = FastAPI(
    title="Noise Monitor",
    description="Collects publicly available noise sensor data and serves it to the map frontend.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _build_response(
    *,
    city: Optional[str],
    lat: Optional[float],
    lon: Optional[float],
    radius_km: Optional[float],
) -> SensorsResponse:
    """Filter the current worldwide snapshot by city bbox or by lat/lon radius."""
    all_sensors, updated_at, upstream_ok = await collector.store.get()

    if lat is not None and lon is not None:
        # Location + radius query.
        r = radius_km if radius_km is not None else config.DEFAULT_RADIUS_KM
        r = max(0.1, min(r, config.MAX_RADIUS_KM))
        matched = collector.filter_radius(all_sensors, lat, lon, r)
        area = Area(
            mode="radius",
            label=None,
            center={"lat": lat, "lon": lon},
            zoom=13,
            radius_km=r,
        )
    else:
        # City query (falls back to default city).
        city_id = (city or config.DEFAULT_CITY).lower()
        meta = config.CITIES.get(city_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"Unknown city '{city_id}'")
        matched = collector.filter_bbox(all_sensors, meta["bbox"])
        area = Area(
            mode="city",
            label=meta["name"],
            center=meta["center"],
            zoom=meta["zoom"],
            bbox=meta["bbox"],
        )

    return SensorsResponse(
        updated_at=updated_at,
        data_available=upstream_ok,
        upstream_ok=upstream_ok,
        count=len(matched),
        area=area,
        sensors=matched,
    )


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health():
    sensors, updated_at, upstream_ok = await collector.store.get()
    return {
        "status": "ok",
        "worldwide_noise_sensors": len(sensors),
        "updated_at": updated_at,
        "upstream_ok": upstream_ok,
    }


@app.get("/api/cities", response_model=List[City])
async def get_cities():
    return [
        City(
            id=cid,
            name=meta["name"],
            country=meta.get("country"),
            center=meta["center"],
            zoom=meta["zoom"],
            bbox=meta["bbox"],
        )
        for cid, meta in config.CITIES.items()
    ]


@app.get("/api/geocode", response_model=List[GeocodeResult])
async def geocode(q: str = Query(..., min_length=1, max_length=200)):
    """Turn a typed location into coordinates via OpenStreetMap Nominatim."""
    params = {"q": q, "format": "json", "limit": 5, "addressdetails": 0}
    headers = {"User-Agent": config.GEOCODER_USER_AGENT}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(config.NOMINATIM_URL, params=params, headers=headers)
            resp.raise_for_status()
            rows = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Geocoding failed for %r: %s", q, exc)
        raise HTTPException(status_code=502, detail="Geocoding service unavailable")

    results: List[GeocodeResult] = []
    for row in rows:
        try:
            results.append(
                GeocodeResult(
                    display_name=row.get("display_name", q),
                    lat=float(row["lat"]),
                    lon=float(row["lon"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return results


@app.get("/api/sensors", response_model=SensorsResponse)
async def get_sensors(
    city: Optional[str] = Query(None, description="City id from /api/cities"),
    lat: Optional[float] = Query(None, ge=-90, le=90),
    lon: Optional[float] = Query(None, ge=-180, le=180),
    radius_km: Optional[float] = Query(None, gt=0),
):
    return await _build_response(city=city, lat=lat, lon=lon, radius_km=radius_km)


@app.post("/api/refresh", response_model=SensorsResponse)
async def refresh(
    city: Optional[str] = Query(None),
    lat: Optional[float] = Query(None, ge=-90, le=90),
    lon: Optional[float] = Query(None, ge=-180, le=180),
    radius_km: Optional[float] = Query(None, gt=0),
):
    """Force an immediate upstream poll, then return the filtered snapshot."""
    await collector.fetch_once()
    return await _build_response(city=city, lat=lat, lon=lon, radius_km=radius_km)


@app.get("/api/config")
async def get_config():
    return {
        "default_city": config.DEFAULT_CITY,
        "default_radius_km": config.DEFAULT_RADIUS_KM,
        "max_radius_km": config.MAX_RADIUS_KM,
        "poll_interval_seconds": config.POLL_INTERVAL_SECONDS,
    }


# Serve the static frontend at the root. Must be mounted last so /api/* wins.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend directory %s not found; only the API is served", FRONTEND_DIR)

    @app.get("/")
    async def root():
        return JSONResponse({"message": "Noise Monitor API. Frontend not mounted."})
