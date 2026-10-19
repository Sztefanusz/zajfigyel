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
  let map = null;
  let markerLayer = null;
  let heatLayer = null;
  let radiusLayer = null; // circle + centre marker for radius queries
  let lastData = null;
  let isRefreshing = false;
  let cities = [];

  function loadQuery() {
    try {
      const raw = localStorage.getItem(STORAGE_QUERY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { mode: "city", city: "budapest" };
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
    if (lastData) render(lastData);
  }

  // ---- Theme ------------------------------------------------------------
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", theme);
    updateThemeLabel();
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
    const sel = document.getElementById("city-select");
    sel.innerHTML = "";
    cities.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.country ? c.name + " (" + c.country + ")" : c.name;
      sel.appendChild(opt);
    });
    if (query.mode === "city" && query.city) sel.value = query.city;
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    const uiInterval = Math.max(30000, Math.min(pollInterval, 120000));
    pollTimer = setInterval(() => fetchSensors(), uiInterval);
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
    await loadCities();
    updateRadiusUI();
    await fetchSensors({ recenter: true });
    startPolling();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
