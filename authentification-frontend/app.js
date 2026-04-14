const CONFIG = {
  API_BASE: "/authentification/backend",
  ALLOWED_DESTINATIONS: ["/webmap/", "/dashboard/"],
  DEFAULT_DESTINATION: "/webmap/",
};

// ── DOM helpers ─────────────────────────────────────────────

const el = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Destination management ──────────────────────────────────

function getNextFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") || "";
  // Only allow known destinations (prevent open redirect)
  return CONFIG.ALLOWED_DESTINATIONS.find((d) => next.startsWith(d)) || "";
}

let selectedDestination = getNextFromUrl() || CONFIG.DEFAULT_DESTINATION;

function destDisplayName(dest) {
  if (dest === "/dashboard/") return "Dashboard";
  return "Webmap";
}

function updateDestination(dest) {
  selectedDestination = dest;

  // Update sidebar active state
  $$("[data-dest]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.dest === dest);
  });

  // Update labels
  const label = destDisplayName(dest);
  const destLabel = el("destLabel");
  if (destLabel) destLabel.textContent = label;
  const goApp = el("goApp");
  if (goApp) {
    goApp.textContent = "Continue to " + label;
  }
}

// ── Toast ───────────────────────────────────────────────────

const toastEl = el("toast");
const toastBody = el("toastBody");
let toastTimeout = null;

function showToast(msg, type = "error") {
  if (!toastEl || !toastBody) return;
  toastBody.textContent = String(msg || "Error");
  toastEl.className = "toast " + type;
  // Force reflow for re-animation
  void toastEl.offsetWidth;
  toastEl.classList.add("visible");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove("visible");
  }, 3000);
}

// ── Loading state ───────────────────────────────────────────

function setLoading(btn, spinner, on) {
  if (btn) btn.disabled = !!on;
  if (spinner) spinner.classList.toggle("hidden", !on);
}

// ── Form validation ─────────────────────────────────────────

function validateForm(form) {
  let valid = true;
  form.querySelectorAll(".form-input[required]").forEach((input) => {
    if (!input.checkValidity()) {
      input.classList.add("invalid");
      valid = false;
    } else {
      input.classList.remove("invalid");
    }
  });
  return valid;
}

// Clear invalid state on input
document.addEventListener("input", (e) => {
  if (e.target.classList.contains("form-input")) {
    e.target.classList.remove("invalid");
  }
});

// ── Tab switching ───────────────────────────────────────────

function switchTab(tabName) {
  $$(".auth-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tabName)
  );
  el("loginForm")?.classList.toggle("hidden", tabName !== "login");
  el("registerForm")?.classList.toggle("hidden", tabName !== "register");
}

$$(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});


// ── View switching ──────────────────────────────────────────

function showView(view) {
  el("authView")?.classList.toggle("hidden", view !== "auth");
  el("loggedInView")?.classList.toggle("hidden", view !== "loggedIn");
}

// ── API helpers ─────────────────────────────────────────────

function isProbablyEmail(s) {
  return String(s || "").trim().includes("@");
}

async function readJsonOrText(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

let refreshPromise = null;

async function refresh() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const r = await fetch(CONFIG.API_BASE + "/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return r.ok;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function api(
  path,
  { method = "GET", body = null, allow401 = false } = {}
) {
  const res = await fetch(CONFIG.API_BASE + path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  });

  if (allow401) return res;

  if (res.status === 401) {
    const ok = await refresh().catch(() => false);
    if (ok) {
      return fetch(CONFIG.API_BASE + path, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : null,
      });
    }
  }

  return res;
}

function fdToObj(form) {
  const fd = new FormData(form);
  const obj = {};
  for (const [k, v] of fd.entries()) obj[k] = String(v);
  obj.newsletter = fd.get("newsletter") === "1";
  return obj;
}

function loginPayload(identifier, password) {
  const id = String(identifier || "").trim();
  const pw = String(password || "");
  if (isProbablyEmail(id)) return { email: id.toLowerCase(), password: pw };
  return { username: id, password: pw };
}

function redirectAfterLogin() {
  window.location.href = selectedDestination;
}

// ── Password match ──────────────────────────────────────────

const regPassword = el("regPassword");
const regPassword2 = el("regPassword2");

function updatePasswordMatch() {
  if (!regPassword || !regPassword2) return;
  const p1 = regPassword.value || "";
  const p2 = regPassword2.value || "";
  if (!p2) {
    regPassword2.setCustomValidity("");
    regPassword2.classList.remove("invalid");
    return;
  }
  if (p1 !== p2) {
    regPassword2.setCustomValidity("Passwords do not match");
    regPassword2.classList.add("invalid");
  } else {
    regPassword2.setCustomValidity("");
    regPassword2.classList.remove("invalid");
  }
}

if (regPassword)
  regPassword.addEventListener("input", updatePasswordMatch);
if (regPassword2)
  regPassword2.addEventListener("input", updatePasswordMatch);

// ── Login form ──────────────────────────────────────────────

const loginForm = el("loginForm");
const loginSubmit = el("loginSubmit");
const loginSpinner = el("loginSpinner");

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(loginForm)) return;

    setLoading(loginSubmit, loginSpinner, true);

    try {
      const f = fdToObj(loginForm);
      const payload = loginPayload(f.identifier, f.password);

      const res = await fetch(CONFIG.API_BASE + "/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await readJsonOrText(res);

      if (!res.ok) {
        showToast(data?.detail || data || `Login failed (${res.status})`);
        return;
      }

      redirectAfterLogin();
    } catch {
      showToast("Network error");
    } finally {
      setLoading(loginSubmit, loginSpinner, false);
    }
  });
}

// ── Register form ───────────────────────────────────────────

const registerForm = el("registerForm");
const registerSubmit = el("registerSubmit");
const registerSpinner = el("registerSpinner");

if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    updatePasswordMatch();
    if (!validateForm(registerForm)) {
      if (regPassword2?.validationMessage) showToast("Passwords do not match");
      return;
    }

    setLoading(registerSubmit, registerSpinner, true);

    try {
      const f = fdToObj(registerForm);

      const res = await fetch(CONFIG.API_BASE + "/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: (f.first_name || "").trim(),
          last_name: (f.last_name || "").trim(),
          username: (f.username || "").trim(),
          company: (f.company || "").trim(),
          email: (f.email || "").trim().toLowerCase(),
          password: f.password || "",
          newsletter: !!f.newsletter,
        }),
      });

      const data = await readJsonOrText(res);

      if (!res.ok) {
        showToast(
          data?.detail || data || `Registration failed (${res.status})`
        );
        return;
      }

      showToast("Registration successful! Please sign in.", "success");
      registerForm.reset();
      registerForm
        .querySelectorAll(".form-input")
        .forEach((i) => i.classList.remove("invalid"));
      if (regPassword2) regPassword2.setCustomValidity("");
      switchTab("login");
    } catch {
      showToast("Network error");
    } finally {
      setLoading(registerSubmit, registerSpinner, false);
    }
  });
}

// ── Logout ──────────────────────────────────────────────────

function attachLogout(btnId) {
  const btn = el(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const spinner = btn.querySelector(".btn-spinner");
    if (spinner) spinner.classList.remove("hidden");
    try {
      await api("/logout", { method: "POST", body: {}, allow401: true });
    } catch {
      /* ignore */
    }
    window.location.reload();
  });
}

attachLogout("logoutBtn");

// ── Background map ──────────────────────────────────────────

function initBgMap() {
  const container = document.getElementById("bg-map");
  if (!container || typeof mapboxgl === "undefined") return;

  mapboxgl.accessToken =
    "pk.eyJ1IjoiYW5kd29vIiwiYSI6ImNrMjlnYnNkdTEwMHozaG5wamJvZHJyangifQ.6M4eeri_Ubmo7NedQT7NuQ";

  // Switzerland bounding box: [SW corner, NE corner]
  const swissBounds = [[3.95, 45.82], [10.49, 47.81]];

  const map = new mapboxgl.Map({
    container,
    style: { version: 8, sources: {}, layers: [] },
    bounds: swissBounds,
    fitBoundsOptions: { padding: 50 },
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
  });


  map.on("load", () => {
    // Load canton boundaries from webmap data
    fetch("https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson")
      .then((r) => (r.ok ? r.json() : null))
      .then((geojson) => {
        if (geojson) {
          map.addSource("cantons", { type: "geojson", data: geojson });
          map.addLayer({
            id: "canton-fill",
            type: "fill",
            source: "cantons",
            paint: {
              "fill-color": "#6366f1",
              "fill-opacity": 0.08,
            },
          });
          map.addLayer({
            id: "canton-borders",
            type: "line",
            source: "cantons",
            paint: {
              "line-color": "#6366f1",
              "line-width": 1.5,
              "line-opacity": 0.4,
            },
          });

          // Highlight layer for hover
          map.addLayer({
            id: "canton-highlight",
            type: "fill",
            source: "cantons",
            paint: {
              "fill-color": "#6366f1",
              "fill-opacity": 0,
            },
          });

          const PEAK = 0.24;

          // Hover: highlight canton under cursor
          let hovered = null;
          map.on("mousemove", "canton-fill", (e) => {
            if (e.features && e.features.length) {
              const name = e.features[0].properties.NAME;
              if (name !== hovered) {
                hovered = name;
                map.setFilter("canton-highlight", ["==", "NAME", name]);
                map.setPaintProperty("canton-highlight", "fill-opacity", PEAK);
              }
            }
          });

          map.on("mouseleave", "canton-fill", () => {
            hovered = null;
            map.setPaintProperty("canton-highlight", "fill-opacity", 0);
          });
        }
      })
      .catch(() => {});

    // IC rail lines (major Swiss intercity routes)
    // Station coordinates
    const S = {
      gva:  [6.14,46.21],  // Geneva Airport
      lsn:  [6.63,46.52],  // Lausanne
      biel: [7.25,47.14],  // Biel/Bienne
      brn:  [7.44,46.95],  // Bern
      thun: [7.63,46.75],  // Thun
      intl: [7.86,46.69],  // Interlaken Ost
      brig: [7.99,46.32],  // Brig
      bsl:  [7.59,47.56],  // Basel SBB
      lzn:  [8.31,47.05],  // Lucerne
      zug:  [8.52,47.17],  // Zug
      zrh:  [8.54,47.38],  // Zürich HB
      wint: [8.72,47.50],  // Winterthur
      sg:   [9.38,47.42],  // St. Gallen
      ror:  [9.49,47.48],  // Rorschach
      rom:  [9.38,47.57],  // Romanshorn
      chur: [9.53,46.85],  // Chur
      lug:  [8.95,46.00],  // Lugano
    };
    const icLines = {
      type: "FeatureCollection",
      features: [
        // IC1: Geneva Airport – Bern – Zürich HB – St. Gallen
        line(S.gva, S.lsn, S.brn, S.zrh, S.wint, S.sg),
        // IC2: Zürich HB – Zug – Lugano
        line(S.zrh, S.zug, S.lug),
        // IC3: Basel SBB – Zürich HB – Chur
        line(S.bsl, S.zrh, S.wint, S.chur),
        // IC5: Lausanne – Biel/Bienne – Zürich HB – St. Gallen (– Rorschach)
        line(S.lsn, S.biel, S.zrh, S.wint, S.sg, S.ror),
        // IC6: Basel SBB – Bern – Brig
        line(S.bsl, S.brn, S.thun, S.brig),
        // IC8: Brig – Bern – Zürich HB – Romanshorn
        line(S.brig, S.thun, S.brn, S.zrh, S.wint, S.rom),
        // IC21: Basel SBB – Lucerne – Lugano
        line(S.bsl, S.lzn, S.lug),
        // IC51: Basel SBB – Biel/Bienne
        line(S.bsl, S.biel),
        // IC61: Basel SBB – Bern – Interlaken Ost
        line(S.bsl, S.brn, S.thun, S.intl),
        // IC81: Interlaken Ost – Bern – Zürich HB – Romanshorn
        line(S.intl, S.thun, S.brn, S.zrh, S.wint, S.rom),
      ],
    };

    // Deduplicate visual segments so overlapping IC lines render as one
    const segSet = new Set();
    const uniqueSegments = [];
    icLines.features.forEach(f => {
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i].join(",");
        const b = coords[i+1].join(",");
        const key = a < b ? a + "|" + b : b + "|" + a;
        if (!segSet.has(key)) {
          segSet.add(key);
          uniqueSegments.push({ type: "Feature", geometry: { type: "LineString", coordinates: [coords[i], coords[i+1]] } });
        }
      }
    });
    const visualLines = { type: "FeatureCollection", features: uniqueSegments };

    map.addSource("ic-lines", { type: "geojson", data: visualLines });
    map.addLayer({
      id: "ic-rails",
      type: "line",
      source: "ic-lines",
      paint: {
        "line-color": "#ef4444",
        "line-width": 2,
        "line-opacity": 0.35,
        "line-dasharray": [4, 2],
      },
    });

    // Station dots at major cities
    const stations = {
      type: "FeatureCollection",
      features: Object.values(S)
        .map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: c } })),
    };

    map.addSource("stations", { type: "geojson", data: stations });
    map.addLayer({
      id: "station-dots",
      type: "circle",
      source: "stations",
      paint: {
        "circle-radius": 4,
        "circle-color": "#ef4444",
        "circle-opacity": 0.4,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": 0.5,
      },
    });

    // Station pulse triggered by trains arriving
    const stationCoords = Object.values(S);
    stations.features.forEach((f, i) => { f.properties = { _idx: i }; });
    map.getSource("stations").setData(stations);

    // Pulse ring layer (expanding ring effect)
    const pulsePoints = { type: "FeatureCollection", features: [] };
    map.addSource("station-pulses", { type: "geojson", data: pulsePoints });
    map.addLayer({
      id: "station-pulse-rings",
      type: "circle",
      source: "station-pulses",
      paint: {
        "circle-radius": 4,
        "circle-color": "transparent",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#6366f1",
        "circle-stroke-opacity": 0.6,
      },
    });

    // Track active pulses: { coord, step }
    const pulses = [];
    const PULSE_DURATION = 30;
    const PULSE_MAX_RADIUS = 14;

    function triggerPulse(coord) {
      // Don't double-pulse the same station
      if (pulses.some(p => p.coord[0] === coord[0] && p.coord[1] === coord[1] && p.step < PULSE_DURATION * 0.5)) return;
      pulses.push({ coord, step: 0 });
    }

    // Find which station index a train is nearest to
    function nearestStation(pos) {
      let best = -1, bestDist = Infinity;
      for (let i = 0; i < stationCoords.length; i++) {
        const dx = pos[0] - stationCoords[i][0];
        const dy = pos[1] - stationCoords[i][1];
        const d = dx*dx + dy*dy;
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return { idx: best, dist: Math.sqrt(bestDist) };
    }

    // ── Animated trains travelling along IC lines ──
    const routes = icLines.features.map(f => f.geometry.coordinates);
    const NUM_TRAINS = routes.length * 2; // one per direction per IC line

    // Compute cumulative distances along a route
    function routeDistances(coords) {
      const dists = [0];
      for (let i = 1; i < coords.length; i++) {
        const dx = coords[i][0] - coords[i-1][0];
        const dy = coords[i][1] - coords[i-1][1];
        dists.push(dists[i-1] + Math.sqrt(dx*dx + dy*dy));
      }
      return dists;
    }

    // Interpolate position along route at progress t (0–1)
    function posAtProgress(coords, dists, t) {
      const totalDist = dists[dists.length - 1];
      const target = t * totalDist;
      for (let i = 1; i < dists.length; i++) {
        if (dists[i] >= target) {
          const segLen = dists[i] - dists[i-1];
          const frac = segLen > 0 ? (target - dists[i-1]) / segLen : 0;
          return [
            coords[i-1][0] + frac * (coords[i][0] - coords[i-1][0]),
            coords[i-1][1] + frac * (coords[i][1] - coords[i-1][1]),
          ];
        }
      }
      return coords[coords.length - 1];
    }

    // Initialize trains at random routes and progress
    const trains = [];
    function initTrain(routeIdx, reverse) {
      const coords = reverse ? [...routes[routeIdx]].reverse() : routes[routeIdx];
      return { routeIdx, reverse, coords, dists: routeDistances(coords), progress: 0, lastStation: -1 };
    }
    for (let i = 0; i < routes.length; i++) {
      const fwd = initTrain(i, false);
      fwd.progress = Math.random();
      trains.push(fwd);
      const rev = initTrain(i, true);
      rev.progress = Math.random();
      trains.push(rev);
    }

    const trainPoints = {
      type: "FeatureCollection",
      features: trains.map(() => ({ type: "Feature", geometry: { type: "Point", coordinates: [0,0] }, properties: {} })),
    };

    map.addSource("trains", { type: "geojson", data: trainPoints });
    map.addLayer({
      id: "train-dots",
      type: "circle",
      source: "trains",
      paint: {
        "circle-radius": 5,
        "circle-color": "#6366f1",
        "circle-opacity": 0.7,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": 0.5,
      },
    });

    setInterval(() => {
      // Update trains and detect station arrivals
      trains.forEach((t, i) => {
        t.progress += 0.003;
        if (t.progress >= 1) {
          // Pulse the terminus station
          triggerPulse(t.coords[t.coords.length - 1]);
          const newTrain = initTrain(t.routeIdx, t.reverse);
          trains[i] = newTrain;
          trainPoints.features[i].geometry.coordinates = posAtProgress(newTrain.coords, newTrain.dists, 0);
        } else {
          const pos = posAtProgress(t.coords, t.dists, t.progress);
          trainPoints.features[i].geometry.coordinates = pos;
          // Check if near a station
          const nearest = nearestStation(pos);
          if (nearest.dist < 0.02 && nearest.idx !== t.lastStation) {
            t.lastStation = nearest.idx;
            triggerPulse(stationCoords[nearest.idx]);
          } else if (nearest.dist >= 0.02) {
            t.lastStation = -1;
          }
        }
      });
      map.getSource("trains").setData(trainPoints);

      // Update pulse animations
      pulsePoints.features = [];
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].step++;
        if (pulses[i].step > PULSE_DURATION) {
          pulses.splice(i, 1);
          continue;
        }
        const p = pulses[i];
        const t = p.step / PULSE_DURATION;
        pulsePoints.features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: p.coord },
          properties: { radius: 4 + (PULSE_MAX_RADIUS - 4) * t, opacity: 0.6 * (1 - t) },
        });
      }
      map.getSource("station-pulses").setData(pulsePoints);
      // Drive radius/opacity from properties
      if (pulsePoints.features.length > 0) {
        map.setPaintProperty("station-pulse-rings", "circle-radius", ["get", "radius"]);
        map.setPaintProperty("station-pulse-rings", "circle-stroke-opacity", ["get", "opacity"]);
      }
    }, 50);
  });
}

function line(/* ...coords */) {
  const coords = Array.from(arguments);
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
  };
}

initBgMap();

// ── Init ────────────────────────────────────────────────────

(async function init() {
  // Set initial destination from ?next= param or default
  updateDestination(selectedDestination);

  // Wire up destination nav clicks
  $$("[data-dest]").forEach((btn) => {
    btn.addEventListener("click", () => updateDestination(btn.dataset.dest));
  });

  // Wire up "Continue to" button with named tab
  const goApp = el("goApp");
  if (goApp) {
    goApp.addEventListener("click", () => redirectAfterLogin());
  }

  // Check if already logged in
  try {
    let meRes = await api("/me", { method: "GET", allow401: true });

    if (!meRes.ok && meRes.status === 401) {
      const ok = await refresh().catch(() => false);
      if (ok) {
        meRes = await api("/me", { method: "GET", allow401: true });
      }
    }

    if (!meRes.ok) {
      showView("auth");
      return;
    }

    showView("loggedIn");
  } catch {
    showView("auth");
  }
})();
