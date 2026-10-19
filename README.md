# Noise Monitor 🔊🗺️

A web app that collects **publicly available noise sensor data** and visualises
current noise levels on an interactive map. Switch between major cities or
search for **any location** to see the sensors within a chosen radius. The map
updates automatically.

- **Backend** — Python / FastAPI service that polls the public
  [Sensor.Community](https://sensor.community) network, keeps every worldwide
  noise sensor reading in memory, and filters it per request by either a city
  bounding box or a location + radius. It also geocodes free-text locations and
  serves the frontend.
- **Frontend** — a lightweight vanilla‑JS single page using
  [Leaflet](https://leafletjs.com) + OpenStreetMap tiles. Features:
  - 🏙️ **major city switcher** (Budapest, Berlin, Stuttgart, London, Paris, Amsterdam, Vienna, Sofia), each annotated with its **live sensor count** so you can see at a glance which cities have data right now
  - 🔎 **location search** — type any place and see sensors within a radius you control
  - 🟢🟡🔴 color‑coded noise markers (dB LAeq)
  - 🔥 **heatmap** view toggle (Markers ↔ Heatmap)
  - ♻️ **auto‑refreshing** map plus a manual **Refresh** button
  - 🚫 honest **"No data available"** state — the app never fabricates data
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
 Sensor.Community public API          FastAPI backend                    Browser
 (data.sensor.community)     poll     ┌───────────────────┐  /api/*       ┌───────────────┐
  all sensors worldwide ───────────►  │  collector         │ ───────────► │  Leaflet map   │
                                      │  (keeps ALL noise   │              │  city switcher │
 Nominatim geocoder  ◄──────────────  │   sensors in mem.)  │              │  location/radius│
                                      │  filter: bbox|radius│              │  EN/HU, themes │
                                      └───────────────────┘              └───────────────┘
```

1. The backend polls the upstream endpoint every `POLL_INTERVAL_SECONDS`
   (default 120s). The payload is the last ~5‑minute average for **every**
   sensor worldwide.
2. The collector keeps every entry carrying `noise_*` values
   (`noise_LAeq`, `noise_LA_max`, `noise_LA_min`) — worldwide — keeping the most
   recent reading per sensor.
3. Each request filters that snapshot:
   - **City mode** (`?city=budapest`) → sensors inside the city bounding box.
   - **Radius mode** (`?lat=..&lon=..&radius_km=..`) → sensors within the given
     radius of a point, annotated with their distance and sorted nearest-first.
4. The frontend fetches on load, on a timer, and whenever you change the city,
   location, or radius — re‑drawing the markers/heatmap automatically.

> **No fabricated data.** Sensor.Community noise sensors are community‑operated,
> so the number reporting in a given area varies and can be zero. When no
> sensors match the selected area, the app shows a clear **"No data available"**
> message instead of filling in demo data. If the upstream source itself cannot
> be reached, a **"Data source unavailable"** message is shown.

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/cities` | List of predefined major cities (id, name, centre, zoom, bbox) with each city's current `sensor_count` |
| `GET /api/sensors?city=<id>` | Noise sensors inside a city's bounding box |
| `GET /api/sensors?lat=<>&lon=<>&radius_km=<>` | Noise sensors within a radius of a point |
| `POST /api/refresh?...` | Force an immediate upstream poll, then return the filtered snapshot (same query params as `/api/sensors`) |
| `GET /api/geocode?q=<text>` | Geocode a free-text location via OpenStreetMap Nominatim |
| `GET /api/health` | Health check + worldwide sensor count + upstream status |
| `GET /api/config` | Default city, default/max radius, poll interval |

Example `GET /api/sensors?lat=47.4979&lon=19.0402&radius_km=5`:

```json
{
  "updated_at": "2026-10-19T10:30:00+00:00",
  "data_available": true,
  "upstream_ok": true,
  "count": 1,
  "area": {
    "mode": "radius",
    "center": { "lat": 47.4979, "lon": 19.0402 },
    "zoom": 13,
    "radius_km": 5.0
  },
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
      "indoor": false,
      "country": "HU",
      "distance_km": 0.0
    }
  ]
}
```

When no sensors match, `count` is `0` and `sensors` is `[]`. `upstream_ok`
distinguishes "no sensors in this area" (`true`) from "could not reach the data
source" (`false`).

---

## Configuration

All settings are environment variables (see `backend/app/config.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SENSOR_COMMUNITY_URL` | `https://data.sensor.community/static/v2/data.json` | Upstream data source |
| `POLL_INTERVAL_SECONDS` | `120` | How often the backend polls upstream |
| `UPSTREAM_TIMEOUT_SECONDS` | `60` | HTTP timeout for the (large) upstream request |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org/search` | Geocoding service |
| `GEOCODER_USER_AGENT` | `noise-monitor/2.0 (public demo)` | User-Agent for geocoding (Nominatim policy) |
| `DEFAULT_RADIUS_KM` | `5` | Default radius for location queries |
| `MAX_RADIUS_KM` | `50` | Maximum allowed radius |
| `DEFAULT_CITY` | `budapest` | City shown on first load (the bundled `docker-compose.yml` overrides this to `berlin`, which usually has the most active sensors, so the map is populated out of the box) |

The frontend shows the city on first load based on `DEFAULT_CITY` (via
`/api/config`), unless you've previously selected a different area — your choice
is remembered in the browser. The city dropdown also displays each city's live
sensor count and a short "N of M cities have live data" hint, refreshed on every
poll.

To add more cities, extend the `CITIES` dict in `backend/app/config.py` with a
centre, zoom, and bounding box.

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
│   │   ├── config.py      # env-driven settings + CITIES registry
│   │   ├── models.py      # pydantic response models
│   │   ├── collector.py   # upstream polling, noise filtering, bbox/radius helpers
│   │   └── main.py        # FastAPI app: cities, sensors, geocode, refresh, static
│   └── requirements.txt
├── frontend/
│   ├── index.html         # city switcher, location search, radius, overlay
│   ├── styles.css         # light/dark theming via CSS variables
│   ├── i18n.js            # EN + HU dictionaries
│   └── app.js             # Leaflet map, auto-refresh, controls, geocoding
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Data attribution

Noise data is provided by the [Sensor.Community](https://sensor.community)
citizen‑science network and is licensed under
[ODbL](https://opendatacommons.org/licenses/odbl/). Geocoding by
[OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/); map tiles
© OpenStreetMap contributors.
