"""FastAPI application: serves the noise API and the static frontend."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import collector, config
from .models import SensorsResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("noise.main")

FRONTEND_DIR = os.environ.get(
    "FRONTEND_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop_event = asyncio.Event()
    # Kick off an immediate fetch so the API has data ASAP, then loop.
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
    title="Budapest Noise Monitor",
    description="Collects publicly available noise sensor data for Budapest and serves it to the map frontend.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    sensors, updated_at, source = await collector.store.get()
    return {"status": "ok", "sensors": len(sensors), "updated_at": updated_at, "source": source}


@app.get("/api/sensors", response_model=SensorsResponse)
async def get_sensors():
    sensors, updated_at, source = await collector.store.get()
    return SensorsResponse(
        updated_at=updated_at,
        source=source,
        count=len(sensors),
        center={"lat": config.BUDAPEST_CENTER_LAT, "lon": config.BUDAPEST_CENTER_LON},
        bbox={
            "min_lat": config.BUDAPEST_MIN_LAT,
            "max_lat": config.BUDAPEST_MAX_LAT,
            "min_lon": config.BUDAPEST_MIN_LON,
            "max_lon": config.BUDAPEST_MAX_LON,
        },
        sensors=sensors,
    )


@app.get("/api/config")
async def get_config():
    """Expose map config so the frontend has no hard-coded coordinates."""
    return {
        "center": {"lat": config.BUDAPEST_CENTER_LAT, "lon": config.BUDAPEST_CENTER_LON},
        "poll_interval_seconds": config.POLL_INTERVAL_SECONDS,
    }


@app.post("/api/refresh", response_model=SensorsResponse)
async def refresh():
    """Force an immediate poll of the upstream source, then return the fresh
    snapshot. Backs the manual "Refresh" button in the UI."""
    await collector.fetch_once()
    sensors, updated_at, source = await collector.store.get()
    return SensorsResponse(
        updated_at=updated_at,
        source=source,
        count=len(sensors),
        center={"lat": config.BUDAPEST_CENTER_LAT, "lon": config.BUDAPEST_CENTER_LON},
        bbox={
            "min_lat": config.BUDAPEST_MIN_LAT,
            "max_lat": config.BUDAPEST_MAX_LAT,
            "min_lon": config.BUDAPEST_MIN_LON,
            "max_lon": config.BUDAPEST_MAX_LON,
        },
        sensors=sensors,
    )


# Serve the static frontend at the root. Must be mounted last so /api/* wins.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:
    logger.warning("Frontend directory %s not found; only the API is served", FRONTEND_DIR)

    @app.get("/")
    async def root():
        return JSONResponse({"message": "Budapest Noise Monitor API. Frontend not mounted."})
