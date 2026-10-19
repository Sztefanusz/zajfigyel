# Budapest Noise Monitor 🔊🗺️

A small web app that collects **publicly available noise sensor data** for
Budapest and visualises the current noise levels on an interactive map that
updates automatically.

- **Backend** — Python / FastAPI service that polls the public
  [Sensor.Community](https://sensor.community) network, filters readings down to
  noise sensors inside the Budapest bounding box, and exposes them through a
  clean JSON API. It also serves the frontend.
- **Frontend** — a lightweight vanilla‑JS single page using
  [Leaflet](https://leafletjs.com) + OpenStreetMap tiles. Features:
  - 🟢🟡🔴 color‑coded noise markers (dB LAeq) on a map of Budapest
  - 🔥 **heatmap** view toggle (Markers ↔ Heatmap)
  - ♻️ **auto‑refreshing** map plus a manual **Refresh** button
  - 🌍 **English / Hungarian** language switch
  - 🌙 **Light / Dark** theme toggle
  - 📊 live overview stats (active sensors, average / loudest / quietest)
- **Docker** — one image runs the whole thing.

---

## Quick start

### With Docker (recommended)

```bash
docker compose up --build
```

Then open <http://localhost:8000>.

### Without Docker

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000>.

---

## How it works

```
 Sensor.Community public API            FastAPI backend                 Browser
 (data.sensor.community)      poll      ┌──────────────┐    /api/sensors ┌────────────┐
  all sensors worldwide  ───────────►   │  collector    │ ──────────────► │  Leaflet    │
                                        │  (bbox + noise │                │  map, EN/HU │
                                        │   filtering)   │                │  light/dark │
                                        └──────────────┘                 └────────────┘
```

1. The backend polls the upstream endpoint every `POLL_INTERVAL_SECONDS`
   (default 120s). The payload is the last ~5‑minute average for **every**
   sensor worldwide.
2. The collector keeps only entries that are **inside the Budapest bounding
   box** *and* carry `noise_*` values (`noise_LAeq`, `noise_LA_max`,
   `noise_LA_min`), keeping the most recent reading per sensor.
3. The result is cached in memory and served at `/api/sensors`.
4. The frontend fetches that endpoint on load and on a timer, re‑drawing the
   map markers automatically.

> **Note on live data:** Sensor.Community noise sensors are community‑operated,
> so the number reporting inside Budapest at any given moment varies and can be
> zero. When no live Budapest noise sensors are available, the backend serves a
> small **demo dataset** so the map is never empty (indicated by a `demo data`
> badge in the header). Set `ENABLE_DEMO_FALLBACK=false` to disable this.

---

## API

| Endpoint        | Description                                             |
|-----------------|---------------------------------------------------------|
| `GET /api/sensors` | Current Budapest noise sensors (JSON, see below)     |
| `POST /api/refresh` | Force an immediate upstream poll, then return the fresh snapshot (same shape as `/api/sensors`). Backs the manual **Refresh** button. |
| `GET /api/health`  | Health check + sensor count + data source            |
| `GET /api/config`  | Map centre + poll interval for the frontend          |

Example `GET /api/sensors`:

```json
{
  "updated_at": "2026-10-19T10:30:00+00:00",
  "source": "sensor.community",
  "count": 1,
  "center": { "lat": 47.4979, "lon": 19.0402 },
  "bbox": { "min_lat": 47.35, "max_lat": 47.61, "min_lon": 18.92, "max_lon": 19.33 },
  "sensors": [
    {
      "sensor_id": 5001,
      "location_id": 111,
      "latitude": 47.4979,
      "longitude": 19.0402,
      "noise_laeq": 63.4,
      "noise_la_max": 71.0,
      "noise_la_min": 55.1,
      "timestamp": "2026-10-19 10:30:00",
      "indoor": false
    }
  ]
}
```

---

## Configuration

All settings are environment variables (see `backend/app/config.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SENSOR_COMMUNITY_URL` | `https://data.sensor.community/static/v2/data.json` | Upstream data source |
| `POLL_INTERVAL_SECONDS` | `120` | How often the backend polls upstream |
| `UPSTREAM_TIMEOUT_SECONDS` | `60` | HTTP timeout for the (large) upstream request |
| `ENABLE_DEMO_FALLBACK` | `true` | Seed demo data when no live sensors are available |
| `BUDAPEST_MIN_LAT` / `MAX_LAT` / `MIN_LON` / `MAX_LON` | `47.35` / `47.61` / `18.92` / `19.33` | Budapest bounding box |
| `BUDAPEST_CENTER_LAT` / `LON` | `47.4979` / `19.0402` | Map centre |

---

## Noise level color scale (A‑weighted LAeq)

| Color | Range | Meaning |
|-------|-------|---------|
| 🟢 green | `< 45 dB` | Quiet |
| 🟢 lime | `45–55 dB` | Moderate |
| 🟡 yellow | `55–65 dB` | Busy |
| 🟠 orange | `65–75 dB` | Loud |
| 🔴 red | `> 75 dB` | Very loud |

---

## Project layout

```
.
├── backend/
│   ├── app/
│   │   ├── config.py      # env-driven settings
│   │   ├── models.py      # pydantic response models
│   │   ├── collector.py   # upstream polling + Budapest/noise filtering
│   │   └── main.py        # FastAPI app, API + static hosting
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── styles.css         # light/dark theming via CSS variables
│   ├── i18n.js            # EN + HU dictionaries
│   └── app.js             # Leaflet map, auto-refresh, controls
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Data attribution

Noise data is provided by the [Sensor.Community](https://sensor.community)
citizen‑science network and is licensed under
[ODbL](https://opendatacommons.org/licenses/odbl/). Map tiles © OpenStreetMap
contributors.
