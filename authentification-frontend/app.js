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
  const destLabelLoggedIn = el("destLabelLoggedIn");
  if (destLabelLoggedIn) destLabelLoggedIn.textContent = label;
  const goApp = el("goApp");
  if (goApp) goApp.href = dest;
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
  window.location.assign(selectedDestination);
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

// ── Init ────────────────────────────────────────────────────

(async function init() {
  // Set initial destination from ?next= param or default
  updateDestination(selectedDestination);

  // Wire up destination nav clicks
  $$("[data-dest]").forEach((btn) => {
    btn.addEventListener("click", () => updateDestination(btn.dataset.dest));
  });

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
