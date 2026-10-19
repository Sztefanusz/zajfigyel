(function () {
  "use strict";

  // ---- Noise level color scale (dB, A-weighted LAeq) --------------------
  // Buckets chosen to reflect perceived urban loudness.
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

  let lang = localStorage.getItem(STORAGE_LANG) || detectLang();
  let theme = localStorage.getItem(STORAGE_THEME) || detectTheme();
  let view = localStorage.getItem(STORAGE_VIEW) || "markers"; // "markers" | "heatmap"
  let pollTimer = null;
  let pollInterval = 120000; // overwritten by /api/config
  let map = null;
  let markerLayer = null;
  let heatLayer = null;
  let lastData = null;
  let isRefreshing = false;

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
    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    });
    updateThemeLabel();
    renderLegend();
    if (lastData) render(lastData); // re-render popups/stats in new language
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
  function initMap(center) {
    map = L.map("map", { zoomControl: true }).setView([center.lat, center.lon], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markerLayer = L.layerGroup();
    heatLayer = L.heatLayer([], {
      radius: 38,
      blur: 28,
      maxZoom: 15,
      minOpacity: 0.35,
      // Gradient aligned with the noise color scale (quiet → very loud).
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

  // Swap which layer is on the map based on the current view mode.
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

  // Map a dB value to a 0..1 intensity for the heatmap gradient.
  // 35 dB (very quiet) -> 0, 85 dB (very loud) -> 1.
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
    if (s.timestamp)
      html += "<tr><td>" + t("popupTime") + "</td><td>" + s.timestamp.replace("T", " ").slice(0, 19) + "</td></tr>";
    html += "</table>";
    if (s.indoor) html += '<span class="indoor-tag">🏠 ' + t("popupIndoor") + "</span>";
    html += "</div>";
    return html;
  }

  function render(data) {
    lastData = data;
    if (!map) initMap(data.center || { lat: 47.4979, lon: 19.0402 });

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
    if (data.source === "demo") {
      badge.textContent = t("sourceDemo");
      badge.className = "source-badge demo";
    } else {
      badge.textContent = t("sourceLive");
      badge.className = "source-badge live";
    }
  }

  // ---- Data fetching ----------------------------------------------------
  async function fetchSensors() {
    try {
      const resp = await fetch("api/sensors", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      render(data);
    } catch (err) {
      console.error("Failed to load sensors", err);
      const updated = document.getElementById("updated-at");
      updated.textContent = t("loadError");
    }
  }

  // Manual refresh: ask the backend to poll upstream right now, then render.
  async function manualRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    const btn = document.getElementById("refresh-btn");
    const label = document.getElementById("refresh-label");
    const prevLabel = label.textContent;
    btn.classList.add("spinning");
    btn.disabled = true;
    label.textContent = t("refreshing");
    try {
      const resp = await fetch("api/refresh", { method: "POST", cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      render(data);
      // Restart the auto-poll timer so the next tick is a full interval away.
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
        return cfg;
      }
    } catch (_) {}
    return null;
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    // Refresh a bit more often than the backend polls so the UI stays fresh.
    const uiInterval = Math.max(30000, Math.min(pollInterval, 120000));
    pollTimer = setInterval(fetchSensors, uiInterval);
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
    // Refresh when the tab becomes visible again.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetchSensors();
    });
  }

  // ---- Boot -------------------------------------------------------------
  async function boot() {
    applyTheme();
    applyI18n();
    wireControls();
    const cfg = await loadConfig();
    if (cfg && cfg.center && !map) initMap(cfg.center);
    await fetchSensors();
    startPolling();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
