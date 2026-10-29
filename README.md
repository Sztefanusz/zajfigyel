# Noise Monitor 🔊🗺️

A web app that collects **publicly available noise sensor data** and visualises
current noise levels on an interactive map. Switch between major cities or
search for **any location** to see the sensors within a chosen radius. The map
updates automatically.

- **Backend** — Python / FastAPI service that polls the public
  [Sensor.Community](https://sensor.community) network, keeps every worldwide
  noise sensor reading in memory, and filters it per request by either a city
  bounding box or a location + radius. It also geocodes free-text locations,
  records per-city history + local events into SQLite on a 10‑minute loop,
  trains an event-aware noise-prediction model, and serves the frontend.
- **Frontend** — a lightweight vanilla‑JS single page using
  [Leaflet](https://leafletjs.com) + OpenStreetMap tiles. Features:
  - 🏙️ **major city switcher** (Budapest, Berlin, Stuttgart, London, Paris, Amsterdam, Vienna, Sofia), each annotated with its **live sensor count** so you can see at a glance which cities have data right now
  - 🔎 **location search** — type any place and see sensors within a radius you control
  - 🟢🟡🔴 color‑coded noise markers (dB LAeq)
  - 🔥 **heatmap** view toggle (Markers ↔ Heatmap)
  - ⏳ **time-travel slider** — scrub through past measurements and future
    predictions on a mini chart; predictions react to detected local events
  - ♻️ **auto‑refreshing** map plus a manual **Refresh** button
  - ℹ️ **Sources & Model** modal — lists every data source and plainly
    explains how the prediction model works
  - 🚫 honest **"No data available"** state — the app never fabricates data
  - 🌍 **English / Hungarian** language switch
  - 🌙 **Light / Dark** theme toggle
  - 📊 live overview stats (active sensors, average / loudest / quietest)
- **Docker** — one image runs the whole thing (with a volume for the history DB).

---

## Background loops, history & predictions

Two loops run continuously on the server:

1. **Live poll** (every `POLL_INTERVAL_SECONDS`, default 2 min) keeps the map's
   worldwide sensor snapshot fresh.
2. **History + events** (every `HISTORY_INTERVAL_SECONDS`, default **10 min**):
   - aggregates per-city noise (avg/min/max LAeq + sensor count) and stores one
     row per city in a lightweight **SQLite** database (`readings` table);
   - fetches each city's **local news RSS feeds**, scans headlines for keywords
     that typically raise noise (concert, festival, match, protest, fireworks,
     roadworks, …) and stores detected **events** (`events` table);
   - prunes data older than `HISTORY_RETENTION_DAYS`.

**Prediction model** (`backend/app/ml.py`): a per-city, ridge-regularised
**linear regression** over cyclical time-of-day features (sine/cosine at daily
and half-daily periods) plus a weekend flag — giving a smooth noise baseline for
any time. Detected local **events** add a decaying dB bump around when they
happen. On the slider's chart the **past is the actual measured readings from
the database** (plotted at their real timestamps and joined by a simple line —
no gap filling), while the **future is the model's prediction** (dashed). The
model is deliberately simple and interpretable (numpy only), which is why the
**Sources & Model** modal can explain it honestly.

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

## Deploy to a public web address

By default the app is only reachable on `localhost:8000`. To make it accessible
**from anywhere** you need three things, none of which the code can provide by
itself:

1. **A server with a public IP** (any VPS / cloud VM running Docker).
2. **A domain name** whose DNS `A`/`AAAA` record points at that server
   — e.g. `noise-monitor.example.com` *(placeholder — use your own)*.
3. **HTTPS**, so browsers trust the site.

> The plain `docker compose up --build` command only runs the app on port 8000
> — it does **not** start any proxy. The Caddy proxy below is opt-in.

The repo ships an optional **Caddy** reverse proxy that handles HTTPS
automatically (free Let's Encrypt certificates). Steps:

```bash
# 1. Point your DNS record at the server, e.g.:
#      noise-monitor.example.com  ->  <your server's public IP>

# 2. Create your Caddyfile from the template and set your real domain + email:
cp Caddyfile.example Caddyfile
#    edit Caddyfile: replace "noise-monitor.example.com" and "admin@example.com"

# 3. Uncomment the `caddy` service (and its volumes) in docker-compose.yml.

# 4. (Optional) set the canonical address so /api/config advertises it:
#    in docker-compose.yml, set  PUBLIC_BASE_URL: "https://noise-monitor.example.com"

# 5. Launch with the public proxy profile:
docker compose --profile public up --build -d
```

Your instance is then available at:

```
https://noise-monitor.example.com      ←  example placeholder; use your domain
```

Notes:
- **Every address above is a placeholder.** Substitute the domain and email you
  actually control — the project does not ship or assume any real host.
- Without a domain you can still test the proxy locally over plain HTTP by using
  the `:80` block in `Caddyfile.example` and browsing to `http://localhost`.
- `PUBLIC_BASE_URL` is purely informational (surfaced via `GET /api/config`); it
  does not itself open the app to the internet — the server + DNS + proxy do.
- Behind a proxy the app still listens on `8000` internally; only Caddy needs
  ports `80`/`443` published to the host.

### Troubleshooting

**Caddy exits with `loading new config: ... no config file to load` (or
"no config file is provided").**
Caddy was started without a `Caddyfile`. The repo ships the template as
`Caddyfile.example`, so you must copy it to the exact filename `Caddyfile`
**before** bringing the proxy up:

```bash
cp Caddyfile.example Caddyfile   # exact name 'Caddyfile', in the repo root
docker compose --profile public up --build -d
```

If you only want the app locally and are seeing a Caddy error at all, make sure
the `caddy` service in `docker-compose.yml` is still commented out and just run
`docker compose up --build` (no `--profile public`).

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
| `GET /api/predict?city=<id>&past_hours=<>&future_hours=<>` | Combined past (measured) + future (predicted) noise series for a city, plus model metadata and the events used |
| `GET /api/events?city=<id>&hours=<>` | Recently detected local-news events for a city |
| `GET /api/sources` | Transparency: every data source the site fetches + a plain explanation of the prediction model |
| `GET /api/history_status` | Row counts in the history DB + loop interval |
| `GET /api/health` | Health check + worldwide sensor count + upstream status |
| `GET /api/config` | Default city, default/max radius, poll interval, past/future windows, public base URL |

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
| `HISTORY_INTERVAL_SECONDS` | `600` | How often the history + events loop runs (10 min) |
| `HISTORY_RETENTION_DAYS` | `30` | Days of history/events kept before pruning |
| `PAST_WINDOW_HOURS` / `FUTURE_WINDOW_HOURS` | `24` / `24` | Span of the time-travel slider |
| `DB_PATH` | `backend/data/noise.db` | SQLite history database path (a Docker volume persists it) |
| `NEWS_USER_AGENT` | `noise-monitor/3.0 (public demo)` | User-Agent for fetching news RSS feeds |
| `PUBLIC_BASE_URL` | `""` (empty) | Canonical public address (e.g. `https://noise-monitor.example.com`), surfaced via `/api/config`. Informational only — see [Deploy to a public web address](#deploy-to-a-public-web-address) |

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
│   │   ├── config.py      # env-driven settings + CITIES + news feeds + ML config
│   │   ├── models.py      # pydantic response models
│   │   ├── collector.py   # upstream polling, noise filtering, bbox/radius helpers
│   │   ├── database.py    # lightweight SQLite history + events store
│   │   ├── news.py        # local-news RSS fetching + event keyword detection
│   │   ├── ml.py          # event-aware ridge-regression noise prediction
│   │   ├── history.py     # 10-min loop: aggregate history + detect events
│   │   └── main.py        # FastAPI app: sensors, geocode, predict, events, sources, static
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
