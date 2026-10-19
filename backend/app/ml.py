"""Event-aware noise-level prediction.

The model is deliberately simple and *explainable* (so we can describe it
honestly in the UI's "how it works" modal) rather than a black box:

A ridge-regularised **linear regression** is fitted, per city, on the stored
historical readings. The features capture the two dominant drivers of urban
noise:

  1. Time-of-day, encoded as sine/cosine pairs at the daily and half-daily
     periods (so the model can learn the morning/evening rush-hour shape
     without discontinuities at midnight).
  2. Weekend vs. weekday (a single 0/1 flag).

The fitted model gives a smooth baseline prediction for any timestamp. On top
of that baseline we add an **event adjustment**: for each detected local news
event whose influence window covers the target time, we add its dB `impact`
(with a gentle decay around the event), because concerts/matches/protests push
noise above the normal daily rhythm.

Why ridge + cyclical features instead of a heavy deep model: it trains in
milliseconds on a few hundred rows, needs only numpy, is stable with little
data, and every coefficient is interpretable — which is exactly what a
transparent public dashboard wants.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

import numpy as np

# Event influence half-window (hours) around an event's timestamp.
EVENT_HALF_WINDOW_H = 6.0
# Global fallback baseline (dB) when a city has essentially no history yet.
FALLBACK_BASELINE = 55.0
RIDGE_LAMBDA = 1.0


def _features(dt: datetime) -> np.ndarray:
    """Cyclical time features for a single timestamp (UTC)."""
    # Fractional hour of day [0, 24).
    h = dt.hour + dt.minute / 60.0
    ang = 2.0 * np.pi * h / 24.0
    is_weekend = 1.0 if dt.weekday() >= 5 else 0.0
    return np.array(
        [
            1.0,                 # intercept
            np.sin(ang),         # daily cycle
            np.cos(ang),
            np.sin(2 * ang),     # half-daily (two rush hours)
            np.cos(2 * ang),
            is_weekend,
        ],
        dtype=float,
    )


def _parse_ts(ts: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


class NoiseModel:
    """A fitted per-city model plus its training metadata."""

    def __init__(self) -> None:
        self.weights: Optional[np.ndarray] = None
        self.n_samples: int = 0
        self.baseline: float = FALLBACK_BASELINE
        self.rmse: Optional[float] = None

    def fit(self, readings: List[Dict]) -> "NoiseModel":
        xs, ys = [], []
        for r in readings:
            avg = r.get("avg_laeq")
            dt = _parse_ts(r.get("ts", ""))
            if avg is None or dt is None:
                continue
            xs.append(_features(dt))
            ys.append(float(avg))

        self.n_samples = len(ys)
        if self.n_samples == 0:
            return self

        X = np.vstack(xs)
        y = np.array(ys, dtype=float)
        self.baseline = float(np.mean(y))

        # Ridge: (XᵀX + λI)⁻¹ Xᵀy, not regularising the intercept column.
        n_feat = X.shape[1]
        reg = RIDGE_LAMBDA * np.eye(n_feat)
        reg[0, 0] = 0.0
        try:
            self.weights = np.linalg.solve(X.T @ X + reg, X.T @ y)
            resid = y - X @ self.weights
            self.rmse = float(np.sqrt(np.mean(resid ** 2)))
        except np.linalg.LinAlgError:
            self.weights = None
        return self

    def baseline_at(self, dt: datetime) -> float:
        if self.weights is None:
            return self.baseline
        return float(_features(dt) @ self.weights)


def event_adjustment(dt: datetime, events: List[Dict]) -> float:
    """Sum of decayed dB impacts for events whose window covers `dt`."""
    bump = 0.0
    for ev in events:
        ets = _parse_ts(ev.get("ts", ""))
        impact = ev.get("impact") or 0.0
        if ets is None or impact <= 0:
            continue
        dh = abs((dt - ets).total_seconds()) / 3600.0
        if dh <= EVENT_HALF_WINDOW_H:
            # Triangular decay: full impact at the event, zero at the edge.
            bump += impact * (1.0 - dh / EVENT_HALF_WINDOW_H)
    return bump


def predict_series(
    readings: List[Dict],
    events: List[Dict],
    *,
    past_hours: int,
    future_hours: int,
    step_minutes: int = 30,
) -> Dict:
    """Build a combined past (actual) + future (predicted) time series.

    Returns a dict with the fitted-model metadata and a list of points:
        { ts, kind: "actual"|"predicted", value, baseline, event_bump }
    Past points carry the measured average where available (falling back to
    the model baseline for gaps); future points are model predictions.
    """
    model = NoiseModel().fit(readings)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)

    # Index actual readings by their rounded bucket for quick lookup.
    actual: Dict[str, float] = {}
    for r in readings:
        dt = _parse_ts(r.get("ts", ""))
        if dt is None or r.get("avg_laeq") is None:
            continue
        actual[dt.strftime("%Y-%m-%dT%H:%M")] = float(r["avg_laeq"])

    points = []
    start = now - timedelta(hours=past_hours)
    end = now + timedelta(hours=future_hours)
    t = start
    step = timedelta(minutes=step_minutes)
    while t <= end:
        is_future = t > now
        baseline = model.baseline_at(t)
        bump = event_adjustment(t, events)
        key = t.strftime("%Y-%m-%dT%H:%M")

        if not is_future and key in actual:
            value = actual[key]
            kind = "actual"
        elif not is_future:
            # Past gap with no measurement — show the model's fitted value.
            value = baseline + bump
            kind = "estimated"
        else:
            value = baseline + bump
            kind = "predicted"

        points.append(
            {
                "ts": t.isoformat(),
                "kind": kind,
                "value": round(value, 1),
                "baseline": round(baseline, 1),
                "event_bump": round(bump, 1),
            }
        )
        t += step

    return {
        "now": now.isoformat(),
        "model": {
            "type": "ridge_linear_cyclical",
            "n_samples": model.n_samples,
            "baseline_db": round(model.baseline, 1),
            "rmse_db": round(model.rmse, 2) if model.rmse is not None else None,
            "trained": model.weights is not None,
        },
        "points": points,
    }
