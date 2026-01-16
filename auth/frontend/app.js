const CONFIG = {
  API_BASE: "/authentification/backend",
  STORAGE_KEY: "auth.tokens.v1",
  REFRESH_SKEW_SECONDS: 60,
  LOGIN_URL: "/authentification/"
};

const el = (id) => document.getElementById(id);

const alertHost = el("alertHost");

const loginForm = el("loginForm");
const registerForm = el("registerForm");

const loginBtn = el("loginBtn");
const loginSpinner = el("loginSpinner");

const registerBtn = el("registerBtn");
const registerSpinner = el("registerSpinner");

const sessionStatus = el("sessionStatus");
const meBtn = el("meBtn");
const logoutBtn = el("logoutBtn");
const meBox = el("meBox");

const regPassword = el("regPassword");
const regPassword2 = el("regPassword2");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showAlert(kind, msg) {
  alertHost.innerHTML = `
    <div class="alert alert-${kind} border mb-3 alert-dismissible fade show" role="alert">
      <div>${escapeHtml(msg)}</div>
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    </div>
  `;
}

function clearAlert() {
  alertHost.innerHTML = "";
}

function setLoading(btn, spinner, on) {
  btn.disabled = !!on;
  spinner.classList.toggle("d-none", !on);
}

function loadTokens() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t?.access_token || !t?.refresh_token) return null;
    return t;
  } catch {
    return null;
  }
}

function saveTokens(t) {
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(t));
}

function clearTokens() {
  localStorage.removeItem(CONFIG.STORAGE_KEY);
}

function parseJwtNoVerify(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function secondsUntilExp(accessToken) {
  const p = parseJwtNoVerify(accessToken);
  if (!p || typeof p.exp !== "number") return null;
  const now = Math.floor(Date.now() / 1000);
  return p.exp - now;
}

async function readJsonOrText(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return await res.json(); } catch { return null; }
  }
  try { return await res.text(); } catch { return null; }
}

/* -------------------- returnTo handling -------------------- */

function getRawReturnTo() {
  try {
    const u = new URL(window.location.href);
    const rt = u.searchParams.get("returnTo");
    return rt ? String(rt) : null;
  } catch {
    return null;
  }
}

function sanitizeReturnTo(rt) {
  if (!rt) return null;
  const s = String(rt).trim();

  if (!s.startsWith("/")) return null;
  if (s.startsWith("//")) return null;
  if (s.includes("\r") || s.includes("\n")) return null;

  // disallow absolute URLs disguised in path
  const lower = s.toLowerCase();
  if (lower.startsWith("/http:") || lower.startsWith("/https:")) return null;

  return s;
}

function getReturnToOrDefault() {
  const safe = sanitizeReturnTo(getRawReturnTo());
  return safe || "/webmap/";
}

function redirectToReturnTo() {
  const target = getReturnToOrDefault();
  window.location.assign(target);
}

function redirectToLoginWithReturnTo() {
  const rt = window.location.pathname + window.location.search + window.location.hash;
  const safeRt = sanitizeReturnTo(rt) || "/webmap/";
  window.location.assign(CONFIG.LOGIN_URL + "?returnTo=" + encodeURIComponent(safeRt));
}

/* -------------------- API wrapper -------------------- */

async function apiFetch(path, { method = "GET", headers = {}, body = null, auth = true, refreshOn401 = true } = {}) {
  const url = CONFIG.API_BASE + path;
  const tokens = loadTokens();

  const h = { "Content-Type": "application/json", ...headers };
  if (auth && tokens?.access_token) h["Authorization"] = "Bearer " + tokens.access_token;

  const res = await fetch(url, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : null
  });

  if (res.status === 401 && refreshOn401 && loadTokens()?.refresh_token) {
    const ok = await refreshTokens();
    if (ok) return apiFetch(path, { method, headers, body, auth, refreshOn401: false });
  }

  return res;
}

let refreshTimer = null;

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const t = loadTokens();
  if (!t?.access_token || !t?.refresh_token) return;

  const sec = secondsUntilExp(t.access_token);
  if (sec == null) return;

  const fireInMs = Math.max(0, (sec - CONFIG.REFRESH_SKEW_SECONDS) * 1000);
  refreshTimer = setTimeout(() => {
    refreshTokens().catch(() => {});
  }, fireInMs);
}

function setSessionUi(loggedIn) {
  meBtn.disabled = !loggedIn;
  logoutBtn.disabled = !loggedIn;
  sessionStatus.textContent = loggedIn ? "Logged in" : "Not logged in";
}

function renderSessionBox(data) {
  const fn = data?.first_name || data?.firstName || "";
  const ln = data?.last_name || data?.lastName || "";
  const co = data?.company || "";
  const line1 = [fn, ln].filter(Boolean).join(" ").trim();
  const line2 = co ? co : "";

  meBox.innerHTML = `
    <div class="fw-semibold">${escapeHtml(line1 || "User")}</div>
    ${line2 ? `<div class="text-body-secondary">${escapeHtml(line2)}</div>` : ""}
  `;
}

function renderLoggedOutBox() {
  meBox.innerHTML = `<div class="text-body-secondary">Not logged in</div>`;
}

function updatePasswordMatchValidity() {
  if (!regPassword || !regPassword2) return;
  const p1 = regPassword.value || "";
  const p2 = regPassword2.value || "";

  if (p2.length === 0) {
    regPassword2.setCustomValidity("");
    return;
  }
  regPassword2.setCustomValidity(p1 === p2 ? "" : "Passwords do not match");
}

if (regPassword && regPassword2) {
  regPassword.addEventListener("input", updatePasswordMatchValidity);
  regPassword2.addEventListener("input", updatePasswordMatchValidity);
}

/* Refresh failure policy:
   - On the auth page: clear tokens and show logged out UI.
   - If this script is used elsewhere, call redirectToLoginWithReturnTo() on failure. */
async function refreshTokens() {
  const t = loadTokens();
  if (!t?.refresh_token) return false;

  const res = await fetch(CONFIG.API_BASE + "/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Refresh-Token": t.refresh_token },
    body: JSON.stringify({ refresh_token: t.refresh_token })
  });

  if (!res.ok) {
    clearTokens();
    setSessionUi(false);
    renderLoggedOutBox();
    return false;
  }

  const data = await res.json();
  if (!data?.access_token || !data?.refresh_token) {
    clearTokens();
    setSessionUi(false);
    renderLoggedOutBox();
    return false;
  }

  saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
  setSessionUi(true);
  scheduleRefresh();
  return true;
}

async function doLogin(email, password) {
  const res = await fetch(CONFIG.API_BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const payload = await readJsonOrText(res);

  if (!res.ok) {
    const msg = payload?.detail || payload || `Login failed (${res.status})`;
    throw new Error(msg);
  }

  if (!payload?.access_token || !payload?.refresh_token) {
    throw new Error("Invalid server response (missing tokens).");
  }

  saveTokens({ access_token: payload.access_token, refresh_token: payload.refresh_token });
  setSessionUi(true);
  scheduleRefresh();
}

async function doRegister(form) {
  const body = {
    first_name: form.first_name,
    last_name: form.last_name,
    username: form.username,
    company: form.company || null,
    email: form.email,
    password: form.password,
    newsletter: !!form.newsletter
  };

  const res = await fetch(CONFIG.API_BASE + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await readJsonOrText(res);

  if (!res.ok) {
    const msg = payload?.detail || payload || `Registration failed (${res.status})`;
    throw new Error(msg);
  }

  return payload;
}

async function doMe() {
  const res = await apiFetch("/me", { method: "GET" });
  const payload = await readJsonOrText(res);

  if (!res.ok) {
    const msg = payload?.detail || payload || `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return payload;
}

async function doLogout() {
  const t = loadTokens();
  if (!t?.refresh_token) {
    clearTokens();
    setSessionUi(false);
    renderLoggedOutBox();
    return;
  }

  await apiFetch("/logout", {
    method: "POST",
    headers: { "X-Refresh-Token": t.refresh_token },
    body: { refresh_token: t.refresh_token },
    auth: true,
    refreshOn401: false
  }).catch(() => {});

  clearTokens();
  setSessionUi(false);
  renderLoggedOutBox();
}

function getFormData(form) {
  const fd = new FormData(form);
  const obj = {};
  for (const [k, v] of fd.entries()) obj[k] = String(v);
  obj.newsletter = fd.get("newsletter") === "1";
  return obj;
}

function validateBootstrap(form) {
  form.classList.add("was-validated");
  return form.checkValidity();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  if (!validateBootstrap(loginForm)) return;

  const f = getFormData(loginForm);

  setLoading(loginBtn, loginSpinner, true);
  try {
    await doLogin(f.email.trim(), f.password);
    // After login: redirect back to the original page
    redirectToReturnTo();
  } catch (err) {
    showAlert("danger", err?.message || "Login failed.");
  } finally {
    setLoading(loginBtn, loginSpinner, false);
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  updatePasswordMatchValidity();

  if (!validateBootstrap(registerForm)) {
    if (regPassword2?.validationMessage) showAlert("danger", "Passwords do not match.");
    return;
  }

  const f = getFormData(registerForm);

  setLoading(registerBtn, registerSpinner, true);
  try {
    await doRegister({
      first_name: f.first_name.trim(),
      last_name: f.last_name.trim(),
      username: f.username.trim(),
      company: (f.company || "").trim(),
      email: f.email.trim(),
      password: f.password,
      newsletter: f.newsletter
    });

    showAlert("success", "Registration successful. Please log in.");
    document.querySelector("#login-tab").click();
    registerForm.reset();
    registerForm.classList.remove("was-validated");
    regPassword2?.setCustomValidity("");
  } catch (err) {
    showAlert("danger", err?.message || "Registration failed.");
  } finally {
    setLoading(registerBtn, registerSpinner, false);
  }
});

meBtn.addEventListener("click", async () => {
  clearAlert();
  try {
    const data = await doMe();
    renderSessionBox(data);
  } catch (err) {
    showAlert("danger", err?.message || "Request failed.");
  }
});

logoutBtn.addEventListener("click", async () => {
  clearAlert();
  await doLogout();
  showAlert("secondary", "Logged out.");
});

(function init() {
  const t = loadTokens();
  const loggedIn = !!t?.access_token && !!t?.refresh_token;
  setSessionUi(loggedIn);

  if (!loggedIn) {
    renderLoggedOutBox();
    return;
  }

  scheduleRefresh();
  meBox.innerHTML = `<div class="text-body-secondary">Loading…</div>`;
  doMe()
    .then(renderSessionBox)
    .catch(() => {
      meBox.innerHTML = `<div class="text-body-secondary">Logged in</div>`;
    });
})();