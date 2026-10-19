"""Background loop that records per-city history and detects local events.

Every HISTORY_INTERVAL_SECONDS (default 10 minutes) it:
  1. Ensures the in-memory sensor snapshot is fresh (triggers a poll).
  2. Aggregates noise readings per city (avg/min/max LAeq + sensor count)
     and upserts one row per city into the SQLite `readings` table.
  3. Fetches each city's local news feeds, detects potential "big events"
     via keyword scoring, and upserts them into the `events` table.
  4. Prunes data older than the retention window.

All synchronous SQLite work is dispatched to a thread so the event loop is
never blocked.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from statistics import mean

from . import collector, config, database, news

logger = logging.getLogger("noise.history")


def _bucket_now() -> str:
    """ISO timestamp rounded down to the aggregation interval."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    bucket_min = max(1, config.HISTORY_INTERVAL_SECONDS // 60)
    minute = (now.minute // bucket_min) * bucket_min
    return now.replace(minute=minute).isoformat()


async def record_once() -> dict:
    """Run a single aggregation + event-detection pass. Returns a summary."""
    # 1. Make sure we have reasonably fresh sensor data.
    all_sensors, _, upstream_ok = await collector.store.get()
    if not all_sensors:
        await collector.fetch_once()
        all_sensors, _, upstream_ok = await collector.store.get()

    ts = _bucket_now()
    summary = {"ts": ts, "cities": {}, "events": 0}

    # 2. Aggregate per city and persist.
    for cid, meta in config.CITIES.items():
        in_city = collector.filter_bbox(all_sensors, meta["bbox"])
        laeqs = [s.noise_laeq for s in in_city if s.noise_laeq is not None]
        if laeqs:
            avg_v, min_v, max_v = mean(laeqs), min(laeqs), max(laeqs)
        else:
            avg_v = min_v = max_v = None
        await asyncio.to_thread(
            database.upsert_reading, cid, ts, avg_v, min_v, max_v, len(in_city)
        )
        summary["cities"][cid] = {"sensor_count": len(in_city), "avg_laeq": avg_v}

    # 3. Fetch + store detected events per city.
    total_events = 0
    for cid in config.CITIES:
        try:
            evs = await news.fetch_city_events(cid)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Event fetch failed for %s: %s", cid, exc)
            evs = []
        for ev in evs:
            await asyncio.to_thread(
                database.upsert_event,
                ev["city"], ev["ts"], ev["title"], ev["source"],
                ev["category"], ev["impact"], ev["url"],
            )
        total_events += len(evs)
    summary["events"] = total_events

    # 4. Prune old rows.
    await asyncio.to_thread(database.prune, config.HISTORY_RETENTION_DAYS)

    logger.info(
        "History tick %s: stored %d cities, %d events (upstream_ok=%s)",
        ts, len(summary["cities"]), total_events, upstream_ok,
    )
    return summary


async def history_loop(stop_event: asyncio.Event) -> None:
    """Run record_once() forever, every HISTORY_INTERVAL_SECONDS."""
    await asyncio.to_thread(database.init_db)
    while not stop_event.is_set():
        try:
            await record_once()
        except Exception:  # noqa: BLE001 - keep the loop alive no matter what
            logger.exception("History tick failed")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=config.HISTORY_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
