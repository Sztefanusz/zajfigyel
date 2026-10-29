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

from datetime import datetime, timedelta, timezone

from . import collector, config, database, history, ml
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
    # Ensure DB tables exist before any request (predict/events) can hit them.
    await asyncio.to_thread(database.init_db)
    # Fast loop: keep the live map snapshot fresh.
    poll_task = asyncio.create_task(collector.poll_loop(stop_event))
    # Slow loop: every ~10 min record per-city history + detect news events.
    history_task = asyncio.create_task(history.history_loop(stop_event))
    logger.info(
        "Started loops (poll %ss, history %ss)",
        config.POLL_INTERVAL_SECONDS, config.HISTORY_INTERVAL_SECONDS,
    )
    try:
        yield
    finally:
        stop_event.set()
        for task in (poll_task, history_task):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        logger.info("Stopped background loops")


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
    all_sensors, _, _ = await collector.store.get()
    return [
        City(
            id=cid,
            name=meta["name"],
            country=meta.get("country"),
            center=meta["center"],
            zoom=meta["zoom"],
            bbox=meta["bbox"],
            sensor_count=len(collector.filter_bbox(all_sensors, meta["bbox"])),
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
        "past_window_hours": config.PAST_WINDOW_HOURS,
        "future_window_hours": config.FUTURE_WINDOW_HOURS,
        # Canonical public address, if configured (empty for local-only).
        "public_base_url": config.PUBLIC_BASE_URL,
    }


@app.get("/api/events")
async def get_events(city: str = Query(...), hours: int = Query(48, ge=1, le=720)):
    """Recent detected local-news events for a city."""
    city_id = city.lower()
    if city_id not in config.CITIES:
        raise HTTPException(status_code=404, detail=f"Unknown city '{city_id}'")
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    events = await asyncio.to_thread(database.get_events, city_id, since)
    return {"city": city_id, "count": len(events), "events": events}


@app.get("/api/predict")
async def predict(
    city: str = Query(...),
    past_hours: Optional[int] = Query(None, ge=1, le=168),
    future_hours: Optional[int] = Query(None, ge=1, le=168),
):
    """Combined past (actual) + future (predicted) noise series for a city.

    The past portion is the actual measured readings from the database (one
    point per stored reading, at its real timestamp — no gap filling). The
    future portion is produced by an event-aware ridge-regression model
    (see app/ml.py). The `now_index` field marks where the future begins.
    """
    city_id = city.lower()
    meta = config.CITIES.get(city_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"Unknown city '{city_id}'")

    past = past_hours or config.PAST_WINDOW_HOURS
    future = future_hours or config.FUTURE_WINDOW_HOURS

    # Load enough history to both train the model and show the past window.
    train_since = (datetime.now(timezone.utc) - timedelta(days=config.HISTORY_RETENTION_DAYS)).isoformat()
    readings = await asyncio.to_thread(database.get_readings, city_id, train_since)
    events_since = (datetime.now(timezone.utc) - timedelta(hours=max(past, future) + 12)).isoformat()
    events = await asyncio.to_thread(database.get_events, city_id, events_since)

    series = await asyncio.to_thread(
        ml.predict_series, readings, events,
        past_hours=past, future_hours=future,
    )
    series["city"] = city_id
    series["city_name"] = meta["name"]
    series["events"] = events
    series["history_points"] = len(readings)
    return series


@app.get("/api/sources")
async def get_sources():
    """Transparency endpoint: everything the site fetches + how the ML works."""
    news_feeds = sorted({f for feeds in config.CITY_NEWS_FEEDS.values() for f in feeds})
    return {
        "data_sources": [
            {
                "name": "Sensor.Community",
                "kind": "Noise sensor network",
                "url": "https://sensor.community",
                "endpoint": config.SENSOR_COMMUNITY_URL,
                "description": "Public citizen-science network of noise/air sensors. We read the 5-minute worldwide snapshot and keep noise sensors.",
                "license": "ODbL",
            },
            {
                "name": "OpenStreetMap Nominatim",
                "kind": "Geocoding",
                "url": "https://nominatim.openstreetmap.org",
                "endpoint": config.NOMINATIM_URL,
                "description": "Turns a typed location into coordinates for radius search.",
                "license": "ODbL",
            },
            {
                "name": "OpenStreetMap tiles",
                "kind": "Map tiles",
                "url": "https://www.openstreetmap.org",
                "endpoint": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                "description": "Base map imagery.",
                "license": "ODbL / CC-BY-SA",
            },
            {
                "name": "Local news RSS feeds",
                "kind": "Event detection",
                "url": None,
                "endpoint": None,
                "description": "Per-city local news feeds scanned for keywords (concerts, matches, protests, fireworks, roadworks, ...) that typically raise noise.",
                "license": "Headlines used for keyword detection only.",
                "feeds": news_feeds,
            },
        ],
        "model": {
            "name": "Event-aware ridge regression (cyclical time features)",
            "summary": (
                "A lightweight linear model is fitted per city on the stored history. "
                "It learns the daily noise rhythm using sine/cosine time-of-day features "
                "plus a weekend flag, giving a smooth baseline for any time. On top of that, "
                "detected local events add a decaying dB bump around when they happen. "
                "Past points show real measurements; future points show the model's prediction."
            ),
            "features": [
                "Time of day (sine & cosine at daily and half-daily periods)",
                "Weekend vs. weekday flag",
                "Local-event impact (decaying bump around event time)",
            ],
            "why": "Trains in milliseconds on little data, needs only numpy, and every coefficient is interpretable — suitable for a transparent public dashboard.",
            "updated_every": f"{config.HISTORY_INTERVAL_SECONDS // 60} minutes",
        },
    }


@app.get("/api/history_status")
async def history_status():
    c = await asyncio.to_thread(database.counts)
    return {"db": c, "interval_minutes": config.HISTORY_INTERVAL_SECONDS // 60}


# Serve the static frontend at the root. Must be mounted last so /api/* wins.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend directory %s not found; only the API is served", FRONTEND_DIR)

    @app.get("/")
    async def root():
        return JSONResponse({"message": "Noise Monitor API. Frontend not mounted."})
