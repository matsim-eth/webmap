const CONFIG = {
  API_BASE: "/authentification/backend",
  DEFAULT_RETURN_TO: "/webmap/",
};

const el = (id) => document.getElementById(id);

const loginForm = el("loginForm");
const registerForm = el("registerForm");

const loginSubmit = el("loginSubmit");
const loginSpinner = el("loginSpinner");

const registerSubmit = el("registerSubmit");
const registerSpinner = el("registerSpinner");

const regPassword = el("regPassword");
const regPassword2 = el("regPassword2");

const toastEl = el("toast");
const toastBody = el("toastBody");

let toast;

// ── Helpers ──────────────────────────────────────────────────────

function setLoading(btn, spinner, on) {
  if (btn) btn.disabled = !!on;
  if (spinner) spinner.classList.toggle("d-none", !on);
}

function showToast(msg) {
  if (!toastEl || !toastBody) return;
  if (!toast) toast = bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 2600, autohide: true });
  toastBody.textContent = String(msg || "Error");
  toast.show();
}

function validateBootstrap(form) {
  if (!form) return false;
  form.classList.add("was-validated");
  return form.checkValidity();
}

function redirectAfterLogin() {
  window.location.assign(CONFIG.DEFAULT_RETURN_TO);
}

function isProbablyEmail(s) {
  const v = String(s || "").trim();
  if (!v) return false;
  return v.includes("@");
}

function showView(view) {
  el("authView").classList.toggle("d-none", view !== "auth");
  el("loggedInView").classList.toggle("d-none", view !== "loggedIn");
}

// ── Password match validation ───────────────────────────────────

function updatePasswordMatchValidity() {
  if (!regPassword || !regPassword2) return;
  const p1 = regPassword.value || "";
  const p2 = regPassword2.value || "";
  if (!p2) {
    regPassword2.setCustomValidity("");
    return;
  }
  regPassword2.setCustomValidity(p1 === p2 ? "" : "Passwords do not match");
}

if (regPassword && regPassword2) {
  regPassword.addEventListener("input", updatePasswordMatchValidity);
  regPassword2.addEventListener("input", updatePasswordMatchValidity);
}

// ── API helpers ─────────────────────────────────────────────────

async function readJsonOrText(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return await res.json(); } catch { return null; }
  }
  try { return await res.text(); } catch { return null; }
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
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function api(path, { method = "GET", body = null, allow401 = false } = {}) {
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

// ── Login form ──────────────────────────────────────────────────

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateBootstrap(loginForm)) return;

    setLoading(loginSubmit, loginSpinner, true);

    try {
      const f = fdToObj(loginForm);
      const payloadIn = loginPayload(f.identifier, f.password);

      const res = await fetch(CONFIG.API_BASE + "/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadIn),
      });

      const payload = await readJsonOrText(res);

      if (!res.ok) {
        const msg = payload?.detail || payload || `Login failed (${res.status})`;
        showToast(msg);
        return;
      }

      // After login, check if admin/dev → redirect to admin panel, else app
      const meRes = await api("/me", { allow401: true });
      if (meRes.ok) {
        const userData = await meRes.json();
        if (userData.admin || userData.dev) {
          window.location.assign("/authentification/admin/");
          return;
        }
      }

      redirectAfterLogin();
    } catch {
      showToast("Network error");
    } finally {
      setLoading(loginSubmit, loginSpinner, false);
    }
  });
}

// ── Register form ───────────────────────────────────────────────

if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    updatePasswordMatchValidity();
    if (!validateBootstrap(registerForm)) {
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

      const payload = await readJsonOrText(res);

      if (!res.ok) {
        const msg = payload?.detail || payload || `Registration failed (${res.status})`;
        showToast(msg);
        return;
      }

      showToast("Registration successful. Please log in.");
      registerForm.reset();
      registerForm.classList.remove("was-validated");
      if (regPassword2) regPassword2.setCustomValidity("");

      bootstrap.Tab.getOrCreateInstance(document.querySelector("#login-tab")).show();
    } catch {
      showToast("Network error");
    } finally {
      setLoading(registerSubmit, registerSpinner, false);
    }
  });
}

// ── Tab links ───────────────────────────────────────────────────

const toRegister = el("toRegister");
const toLogin = el("toLogin");

if (toRegister) {
  toRegister.addEventListener("click", () => {
    bootstrap.Tab.getOrCreateInstance(document.querySelector("#register-tab")).show();
  });
}

if (toLogin) {
  toLogin.addEventListener("click", () => {
    bootstrap.Tab.getOrCreateInstance(document.querySelector("#login-tab")).show();
  });
}

// ── Logout handlers ─────────────────────────────────────────────

function attachLogout(btnId) {
  const btn = el(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api("/logout", { method: "POST", body: {}, allow401: true });
    } catch { /* ignore */ }
    window.location.reload();
  });
}

attachLogout("logoutBtn");

// ── Init ────────────────────────────────────────────────────────

(async function init() {
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

    const userData = await meRes.json();

    if (userData.admin || userData.dev) {
      window.location.assign("/authentification/admin/");
    } else {
      showView("loggedIn");
    }
  } catch {
    showView("auth");
  }
})();
