(function () {
  "use strict";

  // ---- Noise level color scale (dB, A-weighted LAeq) --------------------
  const SCALE = [
    { max: 45, color: "#2ecc71", key: "legendQuiet", range: "< 45 dB" },
    { max: 55, color: "#a3d900", key: "legendModerate", range: "45–55" },
    { max: 65, color: "#f1c40f", key: "legendBusy", range: "55–65" },
    { max: 75, color: "#e67e22", key: "legendLoud", range: "65–75" },
    { max: Infinity, color: "#e74c3c", key: "legendVeryLoud", range: "> 75 dB" },
  ];

  function colorForLevel(db) {
    if (db == null || isNaN(db)) return "#94a3b8";
    for (const b of SCALE) if (db < b.max) return b.color;
    return SCALE[SCALE.length - 1].color;
  }

  // ---- State ------------------------------------------------------------
  const STORAGE_LANG = "noise.lang";
  const STORAGE_THEME = "noise.theme";
  const STORAGE_VIEW = "noise.view";
  const STORAGE_QUERY = "noise.query";

  let lang = localStorage.getItem(STORAGE_LANG) || detectLang();
  let theme = localStorage.getItem(STORAGE_THEME) || detectTheme();
  let view = localStorage.getItem(STORAGE_VIEW) || "markers"; // "markers" | "heatmap"

  // The active area query. Either a city id, or a lat/lon + radius.
  let query = loadQuery();

  let pollTimer = null;
  let pollInterval = 120000;
  let defaultRadius = 5;
  let maxRadius = 50;
  let defaultCity = "budapest";
  let map = null;
  let markerLayer = null;
  let heatLayer = null;
  let radiusLayer = null; // circle + centre marker for radius queries
  let lastData = null;
  let isRefreshing = false;
  let cities = [];

  // Timeline (time-travel) state.
  let pastHours = 24;
  let futureHours = 24;
  let tlSeries = null; // { now, model, points: [...] }
  let tlNowIndex = 0;

  function loadQuery() {
    try {
      const raw = localStorage.getItem(STORAGE_QUERY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    // No saved query yet; filled from backend default_city during boot.
    return null;
  }
  function saveQuery() {
    localStorage.setItem(STORAGE_QUERY, JSON.stringify(query));
  }

  function detectLang() {
    const n = (navigator.language || "en").toLowerCase();
    return n.startsWith("hu") ? "hu" : "en";
  }
  function detectTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function t(key) {
    const dict = window.I18N[lang] || window.I18N.en;
    return dict[key] != null ? dict[key] : (window.I18N.en[key] || key);
  }

  // ---- i18n application -------------------------------------------------
  function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (el.hasAttribute("content")) el.setAttribute("content", val);
      else el.textContent = val;
    });
    // Attribute translations, e.g. data-i18n-attr="placeholder:searchPlaceholder"
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.getAttribute("data-i18n-attr").split(",").forEach((pair) => {
        const [attr, key] = pair.split(":");
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
      });
    });
    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    });
    updateThemeLabel();
    renderLegend();
    if (cities.length) updateCityHint();
    if (lastData) render(lastData);
    if (tlSeries) {
      drawTimeline();
      updateTimelineReadout(Number(document.getElementById("tl-slider").value));
    }
  }

  // ---- Theme ------------------------------------------------------------
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", theme);
    updateThemeLabel();
    // Canvas colors come from CSS vars, so redraw after a theme switch.
    if (typeof drawTimeline === "function") drawTimeline();
  }
  function updateThemeLabel() {
    const icon = document.getElementById("theme-icon");
    const label = document.getElementById("theme-label");
    if (theme === "dark") {
      icon.textContent = "☀️";
      label.textContent = t("themeLight");
    } else {
      icon.textContent = "🌙";
      label.textContent = t("themeDark");
    }
  }

  // ---- Legend -----------------------------------------------------------
  function renderLegend() {
    const ul = document.getElementById("legend");
    ul.innerHTML = "";
    SCALE.forEach((b) => {
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="swatch" style="background:' + b.color + '"></span>' +
        "<span>" + t(b.key) + "</span>" +
        '<span class="range">' + b.range + "</span>";
      ul.appendChild(li);
    });
  }

  // ---- Map --------------------------------------------------------------
  function initMap(center, zoom) {
    map = L.map("map", { zoomControl: true }).setView([center.lat, center.lon], zoom || 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    markerLayer = L.layerGroup();
    radiusLayer = L.layerGroup().addTo(map);
    heatLayer = L.heatLayer([], {
      radius: 38,
      blur: 28,
      maxZoom: 15,
      minOpacity: 0.35,
      gradient: {
        0.0: "#2ecc71",
        0.35: "#a3d900",
        0.55: "#f1c40f",
        0.75: "#e67e22",
        1.0: "#e74c3c",
      },
    });
    applyViewLayer();
  }

  function applyViewLayer() {
    if (!map) return;
    if (view === "heatmap") {
      if (markerLayer && map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
      if (heatLayer && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
    } else {
      if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
      if (markerLayer && !map.hasLayer(markerLayer)) markerLayer.addTo(map);
    }
    document.querySelectorAll(".view-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.view === view));
    });
  }

  function heatIntensity(db) {
    if (db == null || isNaN(db)) return 0.4;
    const clamped = Math.max(35, Math.min(85, db));
    return (clamped - 35) / 50;
  }

  function markerIcon(db) {
    const color = colorForLevel(db);
    const label = db == null || isNaN(db) ? "?" : Math.round(db);
    const size = 34;
    return L.divIcon({
      className: "",
      html:
        '<div class="noise-marker" style="width:' + size + "px;height:" + size +
        "px;background:" + color + '">' + label + "</div>",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function popupHtml(s) {
    const fmt = (v) => (v == null || isNaN(v) ? t("noData") : v.toFixed(1) + " dB");
    let html =
      '<div class="popup"><h3>' + t("popupSensor") + " #" + s.sensor_id + "</h3><table>" +
      "<tr><td>" + t("popupLaeq") + "</td><td>" + fmt(s.noise_laeq) + "</td></tr>" +
      "<tr><td>" + t("popupMax") + "</td><td>" + fmt(s.noise_la_max) + "</td></tr>" +
      "<tr><td>" + t("popupMin") + "</td><td>" + fmt(s.noise_la_min) + "</td></tr>";
    if (s.distance_km != null)
      html += "<tr><td>" + t("popupDistance") + "</td><td>" + s.distance_km.toFixed(2) + " km</td></tr>";
    if (s.timestamp)
      html += "<tr><td>" + t("popupTime") + "</td><td>" + s.timestamp.replace("T", " ").slice(0, 19) + "</td></tr>";
    html += "</table>";
    if (s.indoor) html += '<span class="indoor-tag">🏠 ' + t("popupIndoor") + "</span>";
    html += "</div>";
    return html;
  }

  // Draw the radius circle + centre pin for a radius query (cleared otherwise).
  function renderRadiusArea(area) {
    if (!radiusLayer) return;
    radiusLayer.clearLayers();
    if (area && area.mode === "radius" && area.center) {
      L.circle([area.center.lat, area.center.lon], {
        radius: (area.radius_km || defaultRadius) * 1000,
        color: "#2563eb",
        weight: 1.5,
        fillColor: "#2563eb",
        fillOpacity: 0.06,
      }).addTo(radiusLayer);
      L.circleMarker([area.center.lat, area.center.lon], {
        radius: 5,
        color: "#2563eb",
        fillColor: "#2563eb",
        fillOpacity: 1,
      }).addTo(radiusLayer);
    }
  }

  function showOverlay(kind) {
    const overlay = document.getElementById("no-data-overlay");
    const title = document.getElementById("no-data-title");
    const text = document.getElementById("no-data-text");
    if (!kind) {
      overlay.classList.remove("is-visible");
      overlay.hidden = true;
      return;
    }
    if (kind === "upstream") {
      title.textContent = t("upstreamDownTitle");
      text.textContent = t("upstreamDownText");
    } else {
      title.textContent = t("noDataTitle");
      text.textContent = t("noDataText");
    }
    overlay.hidden = false;
    overlay.classList.add("is-visible");
  }

  function fitToArea(area) {
    if (!map || !area) return;
    if (area.mode === "radius" && area.center) {
      // Fit the circle bounds so the whole radius is visible.
      const r = (area.radius_km || defaultRadius) * 1000;
      const circle = L.circle([area.center.lat, area.center.lon], { radius: r });
      map.fitBounds(circle.getBounds(), { padding: [30, 30] });
    } else if (area.bbox) {
      map.fitBounds(
        [
          [area.bbox.min_lat, area.bbox.min_lon],
          [area.bbox.max_lat, area.bbox.max_lon],
        ],
        { padding: [20, 20] }
      );
    } else if (area.center) {
      map.setView([area.center.lat, area.center.lon], area.zoom || 12);
    }
  }

  // ---- Rendering --------------------------------------------------------
  function render(data, opts) {
    lastData = data;
    const area = data.area || { mode: "city", center: { lat: 47.4979, lon: 19.0402 } };
    if (!map) initMap(area.center, area.zoom);

    markerLayer.clearLayers();
    const levels = [];
    const heatPoints = [];
    (data.sensors || []).forEach((s) => {
      const m = L.marker([s.latitude, s.longitude], { icon: markerIcon(s.noise_laeq) });
      m.bindPopup(popupHtml(s));
      m.addTo(markerLayer);
      heatPoints.push([s.latitude, s.longitude, heatIntensity(s.noise_laeq)]);
      if (s.noise_laeq != null && !isNaN(s.noise_laeq)) levels.push(s.noise_laeq);
    });
    if (heatLayer) heatLayer.setLatLngs(heatPoints);
    renderRadiusArea(area);

    if (opts && opts.recenter) fitToArea(area);

    // Stats
    document.getElementById("stat-count").textContent = data.count ?? (data.sensors || []).length;
    const fmtDb = (v) => (v == null ? "—" : v.toFixed(1) + " dB");
    if (levels.length) {
      const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
      document.getElementById("stat-avg").textContent = fmtDb(avg);
      document.getElementById("stat-max").textContent = fmtDb(Math.max.apply(null, levels));
      document.getElementById("stat-min").textContent = fmtDb(Math.min.apply(null, levels));
    } else {
      document.getElementById("stat-avg").textContent = "—";
      document.getElementById("stat-max").textContent = "—";
      document.getElementById("stat-min").textContent = "—";
    }

    // Updated-at + source badge
    const updated = document.getElementById("updated-at");
    updated.textContent = data.updated_at
      ? new Date(data.updated_at).toLocaleTimeString(lang === "hu" ? "hu-HU" : "en-GB")
      : t("never");
    const badge = document.getElementById("source-badge");
    badge.textContent = t("sourceLive");
    badge.className = "source-badge live";

    // No-data / upstream handling. We never fabricate data: if the area has
    // zero sensors we tell the user plainly.
    if (data.count === 0) {
      showOverlay(data.upstream_ok ? "nodata" : "upstream");
    } else {
      showOverlay(null);
    }
  }

  // ---- Query string builder ---------------------------------------------
  function buildParams() {
    const p = new URLSearchParams();
    if (query.mode === "radius" && query.lat != null && query.lon != null) {
      p.set("lat", query.lat);
      p.set("lon", query.lon);
      p.set("radius_km", query.radius || defaultRadius);
    } else {
      p.set("city", query.city || "budapest");
    }
    return p.toString();
  }

  // ---- Data fetching ----------------------------------------------------
  async function fetchSensors(opts) {
    try {
      const resp = await fetch("api/sensors?" + buildParams(), { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      render(data, opts);
    } catch (err) {
      console.error("Failed to load sensors", err);
      document.getElementById("updated-at").textContent = t("loadError");
    }
  }

  async function manualRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    const btn = document.getElementById("refresh-btn");
    const label = document.getElementById("refresh-label");
    btn.classList.add("spinning");
    btn.disabled = true;
    label.textContent = t("refreshing");
    try {
      const resp = await fetch("api/refresh?" + buildParams(), { method: "POST", cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      render(data);
      loadCities(); // refresh per-city counts after the forced poll
      startPolling();
    } catch (err) {
      console.error("Manual refresh failed", err);
      document.getElementById("updated-at").textContent = t("loadError");
    } finally {
      isRefreshing = false;
      btn.classList.remove("spinning");
      btn.disabled = false;
      label.textContent = t("refresh");
    }
  }

  async function loadConfig() {
    try {
      const resp = await fetch("api/config", { cache: "no-store" });
      if (resp.ok) {
        const cfg = await resp.json();
        if (cfg.poll_interval_seconds) pollInterval = cfg.poll_interval_seconds * 1000;
        if (cfg.default_radius_km) defaultRadius = cfg.default_radius_km;
        if (cfg.max_radius_km) maxRadius = cfg.max_radius_km;
        if (cfg.default_city) defaultCity = cfg.default_city;
        if (cfg.past_window_hours) pastHours = cfg.past_window_hours;
        if (cfg.future_window_hours) futureHours = cfg.future_window_hours;
        return cfg;
      }
    } catch (_) {}
    return null;
  }

  async function loadCities() {
    try {
      const resp = await fetch("api/cities", { cache: "no-store" });
      if (resp.ok) cities = await resp.json();
    } catch (_) {}
    renderCityOptions();
    if (query && query.mode === "city" && query.city) {
      document.getElementById("city-select").value = query.city;
    }
  }

  // Build the city <option>s, including a live "sensors with data" hint.
  // Cities are sorted so those with data appear first.
  function renderCityOptions() {
    const sel = document.getElementById("city-select");
    const current = sel.value || (query && query.city);
    sel.innerHTML = "";
    const sorted = cities.slice().sort((a, b) => {
      const ca = a.sensor_count || 0;
      const cb = b.sensor_count || 0;
      if (cb !== ca) return cb - ca; // more data first
      return a.name.localeCompare(b.name);
    });
    sorted.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      const base = c.country ? c.name + " (" + c.country + ")" : c.name;
      const n = c.sensor_count || 0;
      // Suffix: "• 8" when data is available, "• —" when none.
      opt.textContent = base + "  •  " + (n > 0 ? n : "—");
      if (n === 0) opt.classList.add("no-data-opt");
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
    updateCityHint(sorted);
  }

  // Short summary line under the dropdown: how many cities have data now.
  function updateCityHint(list) {
    const hint = document.getElementById("city-hint");
    if (!hint) return;
    const withData = (list || cities).filter((c) => (c.sensor_count || 0) > 0).length;
    const total = (list || cities).length;
    hint.textContent = t("cityHint")
      .replace("{with}", String(withData))
      .replace("{total}", String(total));
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    const uiInterval = Math.max(30000, Math.min(pollInterval, 120000));
    pollTimer = setInterval(() => {
      fetchSensors();
      loadCities(); // keep the per-city sensor counts fresh
      loadTimeline(); // refresh predictions as new history lands
    }, uiInterval);
  }

  // ---- Location controls -------------------------------------------------
  function updateRadiusUI() {
    const row = document.getElementById("radius-row");
    const range = document.getElementById("radius-range");
    const value = document.getElementById("radius-value");
    range.max = String(maxRadius);
    const r = query.mode === "radius" ? (query.radius || defaultRadius) : defaultRadius;
    range.value = String(r);
    value.textContent = String(r);
    row.hidden = query.mode !== "radius";
  }

  async function selectCity(cityId) {
    query = { mode: "city", city: cityId };
    saveQuery();
    updateRadiusUI();
    clearGeoResults();
    await fetchSensors({ recenter: true });
    loadTimeline();
  }

  async function selectLocation(lat, lon, label) {
    query = {
      mode: "radius",
      lat: Number(lat),
      lon: Number(lon),
      radius: query.radius || defaultRadius,
      label: label || null,
    };
    saveQuery();
    updateRadiusUI();
    clearGeoResults();
    await fetchSensors({ recenter: true });
    loadTimeline(); // will show the "pick a city" note for radius mode
  }

  function clearGeoResults() {
    const ul = document.getElementById("geo-results");
    ul.innerHTML = "";
    ul.hidden = true;
  }

  function renderGeoResults(rows) {
    const ul = document.getElementById("geo-results");
    ul.innerHTML = "";
    if (!rows || rows.length === 0) {
      const li = document.createElement("li");
      li.className = "info";
      li.textContent = t("geoNoResults");
      ul.appendChild(li);
      ul.hidden = false;
      return;
    }
    rows.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r.display_name;
      li.addEventListener("click", () => selectLocation(r.lat, r.lon, r.display_name));
      ul.appendChild(li);
    });
    ul.hidden = false;
  }

  async function doSearch(evt) {
    if (evt) evt.preventDefault();
    const input = document.getElementById("location-input");
    const btn = document.getElementById("search-btn");
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("searching");
    try {
      const resp = await fetch("api/geocode?q=" + encodeURIComponent(q), { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const rows = await resp.json();
      renderGeoResults(rows);
    } catch (err) {
      console.error("Geocode failed", err);
      const ul = document.getElementById("geo-results");
      ul.innerHTML = '<li class="info">' + t("geoError") + "</li>";
      ul.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  // ---- Timeline (time travel: past data ↔ future predictions) -----------
  function currentCityForTimeline() {
    // Timeline is city-scoped; radius mode has no city history.
    return query && query.mode === "city" ? query.city : null;
  }

  async function loadTimeline() {
    const note = document.getElementById("tl-note");
    const city = currentCityForTimeline();
    if (!city) {
      tlSeries = null;
      drawTimeline();
      note.textContent = t("tlNoteRadius");
      return;
    }
    try {
      const resp = await fetch(
        "api/predict?city=" + encodeURIComponent(city) +
          "&past_hours=" + pastHours + "&future_hours=" + futureHours,
        { cache: "no-store" }
      );
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      tlSeries = await resp.json();
      // Index of the point nearest "now" — the boundary of past/future.
      tlNowIndex = tlSeries.points.findIndex((p) => p.kind !== "actual" && p.kind !== "estimated");
      if (tlNowIndex < 0) tlNowIndex = tlSeries.points.length - 1;
      const slider = document.getElementById("tl-slider");
      slider.max = String(Math.max(0, tlSeries.points.length - 1));
      slider.value = String(tlNowIndex);
      drawTimeline();
      updateTimelineReadout(tlNowIndex);

      const name = (tlSeries.city_name || city);
      const hasHistory = (tlSeries.history_points || 0) > 2;
      note.textContent = hasHistory
        ? t("tlNoteCity").replace("{city}", name)
        : t("tlNoHistory");
    } catch (err) {
      console.error("Timeline load failed", err);
      tlSeries = null;
      drawTimeline();
    }
  }

  function kindClass(kind) {
    if (kind === "actual") return "actual";
    if (kind === "predicted") return "predicted";
    return "estimated";
  }
  function kindLabel(kind) {
    if (kind === "actual") return t("tlPast");
    if (kind === "predicted") return t("tlPredicted");
    return t("tlEstimated");
  }

  function fmtClock(iso) {
    const d = new Date(iso);
    return d.toLocaleString(lang === "hu" ? "hu-HU" : "en-GB", {
      weekday: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  function updateTimelineReadout(idx) {
    if (!tlSeries || !tlSeries.points.length) {
      document.getElementById("tl-time").textContent = "—";
      document.getElementById("tl-value").textContent = "—";
      document.getElementById("tl-kind").textContent = "—";
      document.getElementById("tl-kind").className = "tl-kind-badge";
      return;
    }
    const p = tlSeries.points[Math.max(0, Math.min(idx, tlSeries.points.length - 1))];
    document.getElementById("tl-time").textContent = fmtClock(p.ts);
    document.getElementById("tl-value").textContent = p.value.toFixed(1) + " dB";
    const badge = document.getElementById("tl-kind");
    badge.textContent = kindLabel(p.kind) + (p.event_bump > 0 ? " · +" + p.event_bump + " dB" : "");
    badge.className = "tl-kind-badge " + kindClass(p.kind);
    drawTimeline(idx); // redraw to move the cursor line
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawTimeline(cursorIdx) {
    const canvas = document.getElementById("tl-chart");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
    const cssH = 120;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!tlSeries || !tlSeries.points.length) {
      ctx.fillStyle = cssVar("--text-muted");
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("—", cssW / 2, cssH / 2);
      return;
    }

    const pts = tlSeries.points;
    const pad = { l: 34, r: 8, t: 10, b: 16 };
    const w = cssW - pad.l - pad.r;
    const h = cssH - pad.t - pad.b;

    const values = pts.map((p) => p.value);
    let vmin = Math.min.apply(null, values);
    let vmax = Math.max.apply(null, values);
    if (vmax - vmin < 8) { const m = (vmin + vmax) / 2; vmin = m - 5; vmax = m + 5; }
    vmin = Math.floor(vmin - 1); vmax = Math.ceil(vmax + 1);

    const x = (i) => pad.l + (w * i) / Math.max(1, pts.length - 1);
    const y = (v) => pad.t + h - (h * (v - vmin)) / (vmax - vmin);

    // Y gridlines + labels
    ctx.strokeStyle = cssVar("--panel-border");
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    const ticks = 3;
    for (let i = 0; i <= ticks; i++) {
      const v = vmin + ((vmax - vmin) * i) / ticks;
      const yy = y(v);
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(cssW - pad.r, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(Math.round(v), pad.l - 4, yy + 3);
    }

    // "Now" divider
    const nowX = x(tlNowIndex);
    ctx.strokeStyle = cssVar("--accent");
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(nowX, pad.t); ctx.lineTo(nowX, pad.t + h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Shade future region faintly
    ctx.fillStyle = cssVar("--accent");
    ctx.globalAlpha = 0.05;
    ctx.fillRect(nowX, pad.t, pad.l + w - nowX, h);
    ctx.globalAlpha = 1;

    // Line: solid for past, dashed for future
    function strokeSegment(fromI, toI, dashed, color) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dashed ? [5, 4] : []);
      for (let i = fromI; i <= toI; i++) {
        const px = x(i), py = y(pts[i].value);
        if (i === fromI) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const pastColor = cssVar("--accent") || "#2563eb";
    const futColor = "#6366f1";
    strokeSegment(0, tlNowIndex, false, pastColor);
    strokeSegment(tlNowIndex, pts.length - 1, true, futColor);

    // Event markers (points with a bump)
    pts.forEach((p, i) => {
      if (p.event_bump > 0 && (i === 0 || pts[i - 1].event_bump === 0)) {
        ctx.fillStyle = "#e67e22";
        ctx.beginPath();
        ctx.arc(x(i), pad.t + 4, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    });

    // Cursor
    const ci = cursorIdx == null ? Number(document.getElementById("tl-slider").value) : cursorIdx;
    const cx = x(ci), cv = pts[ci] ? pts[ci].value : vmin;
    ctx.fillStyle = cssVar("--text");
    ctx.beginPath();
    ctx.arc(cx, y(cv), 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = cssVar("--panel");
    ctx.lineWidth = 2;
    ctx.stroke();

    // Axis labels
    document.getElementById("tl-start").textContent = fmtClock(pts[0].ts);
    document.getElementById("tl-end").textContent = fmtClock(pts[pts.length - 1].ts);
  }

  // ---- Sources & Model modal --------------------------------------------
  function openModal() {
    const backdrop = document.getElementById("modal-backdrop");
    backdrop.hidden = false;
    loadSources();
  }
  function closeModal() {
    document.getElementById("modal-backdrop").hidden = true;
  }

  async function loadSources() {
    const body = document.getElementById("modal-body");
    body.innerHTML = '<p class="loading">' + t("loading") + "</p>";
    try {
      const resp = await fetch("api/sources", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      renderSources(data);
    } catch (err) {
      console.error("Sources load failed", err);
      body.innerHTML = '<p class="loading">' + t("loadError") + "</p>";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderSources(data) {
    const body = document.getElementById("modal-body");
    let html = "<h3>" + t("modalSourcesH") + "</h3>";
    (data.data_sources || []).forEach((s) => {
      html += '<div class="source-card">';
      html += '<div class="sc-top"><span class="sc-name">' + esc(s.name) +
              '</span><span class="sc-kind">' + esc(s.kind) + "</span></div>";
      html += "<p>" + esc(s.description) + "</p>";
      if (s.url) html += '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + "</a>";
      if (s.license) html += '<div class="sc-meta">' + t("modalLicense") + ": " + esc(s.license) + "</div>";
      if (s.feeds && s.feeds.length) {
        html += '<div class="sc-meta">' + t("modalFeeds") + ':</div><ul class="feeds-list">';
        s.feeds.forEach((f) => { html += "<li>" + esc(f) + "</li>"; });
        html += "</ul>";
      }
      html += "</div>";
    });

    const m = data.model || {};
    html += "<h3>" + t("modalModelH") + "</h3><div class=\"model-box\">";
    html += "<p><strong>" + esc(m.name) + "</strong></p>";
    html += "<p>" + esc(m.summary) + "</p>";
    if (m.features && m.features.length) {
      html += "<p><strong>" + t("modalFeaturesH") + ":</strong></p><ul>";
      m.features.forEach((f) => { html += "<li>" + esc(f) + "</li>"; });
      html += "</ul>";
    }
    if (m.why) html += '<p class="why">' + esc(m.why) + "</p>";
    if (m.updated_every) html += '<span class="meta-chip">' + t("modalUpdated") + ": " + esc(m.updated_every) + "</span>";
    html += "</div>";
    body.innerHTML = html;
  }

  // ---- Event wiring -----------------------------------------------------
  function wireControls() {
    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.addEventListener("click", () => {
        lang = b.dataset.lang;
        localStorage.setItem(STORAGE_LANG, lang);
        applyI18n();
      });
    });
    document.getElementById("theme-btn").addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_THEME, theme);
      applyTheme();
    });
    document.getElementById("refresh-btn").addEventListener("click", manualRefresh);
    document.querySelectorAll(".view-btn").forEach((b) => {
      b.addEventListener("click", () => {
        view = b.dataset.view;
        localStorage.setItem(STORAGE_VIEW, view);
        applyViewLayer();
      });
    });

    document.getElementById("city-select").addEventListener("change", (e) => {
      selectCity(e.target.value);
    });
    document.getElementById("search-form").addEventListener("submit", doSearch);

    // Sources & Model modal
    document.getElementById("sources-btn").addEventListener("click", openModal);
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });

    // Timeline slider scrubbing
    document.getElementById("tl-slider").addEventListener("input", (e) => {
      updateTimelineReadout(Number(e.target.value));
    });
    window.addEventListener("resize", () => drawTimeline());

    const range = document.getElementById("radius-range");
    range.addEventListener("input", (e) => {
      document.getElementById("radius-value").textContent = e.target.value;
    });
    range.addEventListener("change", (e) => {
      if (query.mode === "radius") {
        query.radius = Number(e.target.value);
        saveQuery();
        fetchSensors({ recenter: true });
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetchSensors();
    });
  }

  // ---- Boot -------------------------------------------------------------
  async function boot() {
    applyTheme();
    applyI18n();
    wireControls();
    await loadConfig();
    // If the user has no saved area yet, start on the backend's default city.
    if (!query) query = { mode: "city", city: defaultCity };
    await loadCities();
    updateRadiusUI();
    await fetchSensors({ recenter: true });
    loadTimeline();
    startPolling();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
