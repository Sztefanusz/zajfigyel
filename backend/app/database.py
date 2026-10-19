"""Lightweight SQLite persistence for historical noise aggregates and events.

We use the Python standard library `sqlite3` (no external DB server) so the
whole app stays a single lightweight container. All synchronous DB calls are
wrapped with `asyncio.to_thread` by the callers that live on the event loop.

Two tables:

  readings(city, ts, avg_laeq, min_laeq, max_laeq, sensor_count)
      One row per city per aggregation tick (every ~10 minutes). `ts` is an
      ISO-8601 UTC timestamp truncated to the aggregation bucket.

  events(city, ts, title, source, category, impact, url)
      Detected "big events" from local news, one row per unique (city,title).
"""
from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from . import config

_local = threading.local()


def _connect() -> sqlite3.Connection:
    """One connection per thread (sqlite3 connections aren't thread-safe)."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(os.path.abspath(config.DB_PATH)), exist_ok=True)
        conn = sqlite3.connect(config.DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        _local.conn = conn
    return conn


def _ensure_tables(conn: sqlite3.Connection) -> None:
    """Create tables on this connection if they don't exist yet.

    Guards against a read arriving before the history loop's init_db(), and is
    effectively free once the per-thread flag is set.
    """
    if getattr(_local, "tables_ready", False):
        return
    _create_schema(conn)
    _local.tables_ready = True


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS readings (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            city         TEXT NOT NULL,
            ts           TEXT NOT NULL,
            avg_laeq     REAL,
            min_laeq     REAL,
            max_laeq     REAL,
            sensor_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE(city, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_readings_city_ts ON readings(city, ts);

        CREATE TABLE IF NOT EXISTS events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            city      TEXT NOT NULL,
            ts        TEXT NOT NULL,
            title     TEXT NOT NULL,
            source    TEXT,
            category  TEXT,
            impact    REAL NOT NULL DEFAULT 0,
            url       TEXT,
            UNIQUE(city, title)
        );
        CREATE INDEX IF NOT EXISTS idx_events_city_ts ON events(city, ts);
        """
    )
    conn.commit()


def init_db() -> None:
    conn = _connect()
    _create_schema(conn)
    _local.tables_ready = True


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #
def upsert_reading(
    city: str,
    ts: str,
    avg_laeq: Optional[float],
    min_laeq: Optional[float],
    max_laeq: Optional[float],
    sensor_count: int,
) -> None:
    conn = _connect()
    _ensure_tables(conn)
    conn.execute(
        """
        INSERT INTO readings (city, ts, avg_laeq, min_laeq, max_laeq, sensor_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(city, ts) DO UPDATE SET
            avg_laeq=excluded.avg_laeq,
            min_laeq=excluded.min_laeq,
            max_laeq=excluded.max_laeq,
            sensor_count=excluded.sensor_count
        """,
        (city, ts, avg_laeq, min_laeq, max_laeq, sensor_count),
    )
    conn.commit()


def upsert_event(
    city: str, ts: str, title: str, source: str, category: str, impact: float, url: str
) -> None:
    conn = _connect()
    _ensure_tables(conn)
    conn.execute(
        """
        INSERT INTO events (city, ts, title, source, category, impact, url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(city, title) DO UPDATE SET
            ts=excluded.ts, source=excluded.source,
            category=excluded.category, impact=excluded.impact, url=excluded.url
        """,
        (city, ts, title, source, category, impact, url),
    )
    conn.commit()


def prune(retention_days: int) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    conn = _connect()
    _ensure_tables(conn)
    conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
    conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
    conn.commit()


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
def get_readings(city: str, since_iso: Optional[str] = None, limit: int = 5000) -> List[Dict]:
    conn = _connect()
    _ensure_tables(conn)
    if since_iso:
        rows = conn.execute(
            "SELECT * FROM readings WHERE city=? AND ts>=? ORDER BY ts ASC LIMIT ?",
            (city, since_iso, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM readings WHERE city=? ORDER BY ts ASC LIMIT ?",
            (city, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def get_events(city: str, since_iso: Optional[str] = None, limit: int = 200) -> List[Dict]:
    conn = _connect()
    _ensure_tables(conn)
    if since_iso:
        rows = conn.execute(
            "SELECT * FROM events WHERE city=? AND ts>=? ORDER BY ts DESC LIMIT ?",
            (city, since_iso, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM events WHERE city=? ORDER BY ts DESC LIMIT ?",
            (city, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def counts() -> Dict[str, int]:
    conn = _connect()
    _ensure_tables(conn)
    r = conn.execute("SELECT COUNT(*) AS c FROM readings").fetchone()["c"]
    e = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"]
    return {"readings": r, "events": e}
