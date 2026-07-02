const CONFIG = {
  API_BASE: "/authentification/backend",
  DATASET_API_BASE: "/backend/datasets",
  OPS_API_BASE: "/backend/ops",
  SYSTEM_EMAILS: ["admin@webmap.local", "dev@local"],
};

const el = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Helpers ──────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ── Toast ────────────────────────────────────────────────────────

const toastEl = el("toast");
const toastBody = el("toastBody");
let toastTimeout = null;

function showToast(msg, type = "error") {
  if (!toastEl || !toastBody) return;
  toastBody.textContent = String(msg || "Error");
  toastEl.className = "toast " + type;
  void toastEl.offsetWidth;
  toastEl.classList.add("visible");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove("visible");
  }, 3000);
}

// ── Modal helpers ────────────────────────────────────────────────

function openModal(id) {
  const overlay = el(id);
  if (!overlay) return;
  overlay.classList.add("visible");
}

function closeModal(id) {
  const overlay = el(id);
  if (!overlay) return;
  overlay.classList.remove("visible");
}

// Close modals via dismiss buttons and overlay click
document.addEventListener("click", (e) => {
  // Dismiss button
  if (e.target.matches("[data-dismiss=modal]")) {
    const overlay = e.target.closest(".modal-overlay");
    if (overlay) overlay.classList.remove("visible");
    return;
  }
  // Click on overlay background
  if (e.target.classList.contains("modal-overlay")) {
    e.target.classList.remove("visible");
  }
});

// Close modal on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $$(".modal-overlay.visible").forEach((m) => m.classList.remove("visible"));
  }
});

// ── Tab switching ────────────────────────────────────────────────

const _tabLoaded = {};

function switchAdminTab(tabName) {
  $$(".admin-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tabName)
  );
  ["users", "datasets", "services", "environment"].forEach((name) => {
    el(`${name}-pane`)?.classList.toggle("active", tabName === name);
  });
  // Lazy-load the ops tabs on first open
  if (tabName === "services" && !_tabLoaded.services) {
    _tabLoaded.services = true;
    loadServices();
  }
  if (tabName === "environment" && !_tabLoaded.environment) {
    _tabLoaded.environment = true;
    loadEnv();
  }
}

$$(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchAdminTab(tab.dataset.tab));
});

// ── API helpers ──────────────────────────────────────────────────

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

async function datasetApi(path, { method = "GET", body = null } = {}) {
  const opts = {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  };
  try {
    let res = await fetch(CONFIG.DATASET_API_BASE + path, opts);
    if (res.status === 401) {
      const ok = await refresh().catch(() => false);
      if (ok) {
        res = await fetch(CONFIG.DATASET_API_BASE + path, opts);
      }
    }
    return res;
  } catch (err) {
    console.warn("datasetApi network error:", err);
    return new Response(JSON.stringify({ detail: "Dataset service unreachable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function isSystemUser(email) {
  return CONFIG.SYSTEM_EMAILS.includes((email || "").toLowerCase());
}

// ── Users ────────────────────────────────────────────────────────

let _currentUser = null;

async function loadUsers(currentUser) {
  _currentUser = currentUser;
  const res = await api("/admin/users");
  if (!res.ok) {
    showToast("Failed to load users");
    return;
  }
  const data = await res.json();
  const tbody = el("usersTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const isPending = (u) => u.approved === false || u.email_verified === false;

  const users = data.users.sort((a, b) => {
    const aSystem = isSystemUser(a.email) ? 0 : 1;
    const bSystem = isSystemUser(b.email) ? 0 : 1;
    if (aSystem !== bSystem) return aSystem - bSystem;
    // Pending accounts float to the top — that's what an admin came for.
    const aPending = isPending(a) ? 0 : 1;
    const bPending = isPending(b) ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return a.id - b.id;
  });

  // Banner: how many accounts wait for approval
  const pendingCount = users.filter((u) => u.approved === false).length;
  const banner = el("pendingBanner");
  if (banner) {
    banner.classList.toggle("hidden", pendingCount === 0);
    const txt = el("pendingBannerText");
    if (txt) txt.textContent =
      `${pendingCount} account${pendingCount === 1 ? "" : "s"} waiting for approval`;
  }

  const statusCell = (u) => {
    if (isSystemUser(u.email)) return '<span class="badge badge-ok">OK</span>';
    const parts = [];
    if (u.email_verified === false) parts.push('<span class="badge badge-warn">unverified</span>');
    if (u.approved === false) parts.push('<span class="badge badge-pending">pending</span>');
    if (!parts.length) parts.push('<span class="badge badge-ok">OK</span>');
    return parts.join(" ");
  };

  for (const u of users) {
    const isSys = isSystemUser(u.email);
    const tr = document.createElement("tr");
    if (isSys) tr.classList.add("system-row");
    if (isPending(u)) tr.classList.add("pending-row");

    tr.innerHTML = `
      <td>${u.id}</td>
      <td>
        ${esc(u.email)}
        ${isSys ? ' <span class="badge badge-system">System</span>' : ""}
      </td>
      <td>${esc(u.username || "-")}</td>
      <td>${esc(u.first_name)} ${esc(u.last_name)}</td>
      <td>${esc(u.company || "-")}</td>
      <td>
        <input type="checkbox" class="toggle-checkbox" data-uid="${u.id}" data-field="admin"
               ${u.admin ? "checked" : ""} ${isSys ? "disabled" : ""} />
      </td>
      <td>
        <input type="checkbox" class="toggle-checkbox" data-uid="${u.id}" data-field="dev"
               ${u.dev ? "checked" : ""} ${isSys ? "disabled" : ""} />
      </td>
      <td>
        <input type="checkbox" class="toggle-checkbox" data-uid="${u.id}" data-field="is_active"
               ${u.is_active ? "checked" : ""} ${isSys ? "disabled" : ""} />
      </td>
      <td>${statusCell(u)}</td>
      <td>
        ${!isSys ? `
          <div class="actions">
            ${u.approved === false ? `<button class="btn btn-approve btn-sm" data-uid="${u.id}" data-action="approve-user">Approve</button>` : ""}
            ${u.email_verified === false ? `<button class="btn btn-outline btn-sm" data-uid="${u.id}" data-action="mark-verified" title="Skip email verification for this user">Mark verified</button>` : ""}
            <button class="btn btn-outline btn-sm" data-uid="${u.id}" data-action="edit-user">Edit</button>
            <button class="btn btn-outline btn-sm" data-uid="${u.id}" data-uname="${esc(u.username || u.email)}" data-action="view-datasets">Datasets</button>

            <button class="btn btn-danger btn-sm" data-uid="${u.id}" data-action="hard-delete">Delete</button>
          </div>
        ` : ""}
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody._users = users;

  // Approve button -> POST /admin/users/{id}/approve
  tbody.querySelectorAll("button[data-action=approve-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await api(`/admin/users/${btn.dataset.uid}/approve`, { method: "POST" });
      if (res.ok) {
        showToast("Account approved", "success");
        loadUsers(_currentUser);
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Approve failed");
        btn.disabled = false;
      }
    });
  });

  // Mark-verified button -> PATCH email_verified=true (admin override)
  tbody.querySelectorAll("button[data-action=mark-verified]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const res = await api(`/admin/users/${btn.dataset.uid}`, {
        method: "PATCH",
        body: { email_verified: true },
      });
      if (res.ok) {
        showToast("Marked as verified", "success");
        loadUsers(_currentUser);
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Update failed");
        btn.disabled = false;
      }
    });
  });

  // Checkbox change -> PATCH
  tbody.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const uid = cb.dataset.uid;
      const field = cb.dataset.field;
      const value = cb.checked;
      const res = await api(`/admin/users/${uid}`, {
        method: "PATCH",
        body: { [field]: value },
      });
      if (!res.ok) {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Update failed");
        cb.checked = !value;
      }
    });
  });

  // Edit button -> open modal
  tbody.querySelectorAll("button[data-action=edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid, 10);
      const user = users.find((u) => u.id === uid);
      if (!user) return;
      openEditModal(user);
    });
  });

  // View Datasets button -> switch to datasets tab with filter
  tbody.querySelectorAll("button[data-action=view-datasets]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.uid, 10);
      const uname = btn.dataset.uname;
      loadDatasets(uid, uname);
      switchAdminTab("datasets");
    });
  });



  // Hard delete button
  tbody.querySelectorAll("button[data-action=hard-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("PERMANENTLY delete this user and ALL their data? This cannot be undone!")) return;
      const uid = btn.dataset.uid;
      const res = await api(`/admin/users/${uid}?hard=true`, { method: "DELETE" });
      if (res.ok) {
        showToast("User permanently deleted", "success");
        await loadUsers(currentUser);
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Failed to delete");
      }
    });
  });
}

// ── Edit User Modal ──────────────────────────────────────────────

function openEditModal(user) {
  el("editUserId").value = user.id;
  el("editEmail").value = user.email || "";
  el("editUsername").value = user.username || "";
  el("editFirstName").value = user.first_name || "";
  el("editLastName").value = user.last_name || "";
  el("editCompany").value = user.company || "";
  el("editPassword").value = "";
  openModal("editUserModal");
}

async function saveUser() {
  const uid = el("editUserId").value;
  const body = {};

  const email = el("editEmail").value.trim();
  const username = el("editUsername").value.trim();
  const firstName = el("editFirstName").value.trim();
  const lastName = el("editLastName").value.trim();
  const company = el("editCompany").value.trim();
  const password = el("editPassword").value;

  if (email) body.email = email;
  if (username) body.username = username;
  body.first_name = firstName;
  body.last_name = lastName;
  body.company = company;
  if (password) body.password = password;

  const res = await api(`/admin/users/${uid}`, { method: "PATCH", body });
  if (res.ok) {
    showToast("User updated", "success");
    closeModal("editUserModal");
    await loadUsers(_currentUser);
  } else {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Update failed");
  }
}

// ── Datasets ─────────────────────────────────────────────────────

let _currentOwnerFilter = null;
let _currentOwnerName = null;
let _allDatasets = [];

function _renderDatasetRows(tbody, datasets, ownerFilter, ownerName) {
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!datasets || datasets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">No datasets.</td></tr>';
    return;
  }

  for (const ds of datasets) {
    const statusCls = ds.status === "active" ? "badge-success" : "badge-secondary";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${ds.id}</code></td>
      <td>${esc(ds.name)}</td>
      <td>${esc(ds.description || "-")}</td>
      <td>${esc(ds.owner_username || "")} <span class="text-muted">(${ds.owner_id})</span></td>
      <td><span class="badge ${statusCls}">${esc(ds.status)}</span></td>
      <td>${ds.created_at ? new Date(ds.created_at).toLocaleDateString() : "-"}</td>
      <td class="text-nowrap">
        <div class="actions">
          ${!ds.is_public ? `<button class="btn btn-outline btn-sm" data-dsid="${ds.id}" data-action="manage-access">Access</button>` : ""}
          <button class="btn btn-outline btn-sm" data-dsid="${ds.id}" data-action="edit-ds">Edit</button>
          <button class="btn btn-danger btn-sm" data-dsid="${ds.id}" data-action="delete-ds">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Access buttons (private datasets only)
  tbody.querySelectorAll("button[data-action=manage-access]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dsid = parseInt(btn.dataset.dsid, 10);
      const ds = _allDatasets.find((d) => d.id === dsid);
      if (ds) openAccessModal(ds);
    });
  });

  // Edit buttons
  tbody.querySelectorAll("button[data-action=edit-ds]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dsid = parseInt(btn.dataset.dsid, 10);
      const ds = _allDatasets.find((d) => d.id === dsid);
      if (ds) openEditDatasetModal(ds);
    });
  });

  // Delete buttons
  tbody.querySelectorAll("button[data-action=delete-ds]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dsid = btn.dataset.dsid;
      const ds = _allDatasets.find((d) => String(d.id) === String(dsid));
      const dsName = ds?.name ? `"${ds.name}"` : "this dataset";
      if (!confirm(
        `Permanently delete ${dsName}?\n\n` +
        `This removes the dataset's entire folder on disk, including any ` +
        `synthetic.duckdb / microcensus.duckdb files within it. This cannot be undone.`
      )) return;
      const res = await datasetApi(`/admin/datasets/${dsid}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        await loadDatasets(_currentOwnerFilter, _currentOwnerName);
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Delete failed");
      }
    });
  });
}

async function loadDatasets(ownerFilter, ownerName) {
  _currentOwnerFilter = ownerFilter || null;
  _currentOwnerName = ownerName || null;

  let url = "/admin/datasets";
  if (ownerFilter) {
    url += `?owner_id=${ownerFilter}`;
  }

  const filterDiv = el("datasetOwnerFilter");
  const filterBadge = el("datasetFilterBadge");

  if (ownerFilter && filterDiv && filterBadge) {
    filterBadge.textContent = `Filtered: ${ownerName || "User " + ownerFilter}`;
    filterDiv.classList.remove("hidden");
  } else if (filterDiv) {
    filterDiv.classList.add("hidden");
  }

  const res = await datasetApi(url);
  if (!res.ok) {
    const publicBody = el("publicDatasetsBody");
    const privateBody = el("privateDatasetsBody");
    if (publicBody) publicBody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">Service unavailable.</td></tr>';
    if (privateBody) privateBody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">Service unavailable.</td></tr>';
    return;
  }

  const data = await res.json();
  _allDatasets = data.datasets || [];

  const publicDatasets = _allDatasets.filter((ds) => ds.is_public);
  const privateDatasets = _allDatasets.filter((ds) => !ds.is_public);

  _renderDatasetRows(el("publicDatasetsBody"), publicDatasets, ownerFilter, ownerName);
  _renderDatasetRows(el("privateDatasetsBody"), privateDatasets, ownerFilter, ownerName);
}

// ── Add Dataset Modal ────────────────────────────────────────────

function openAddDatasetModal() {
  const select = el("addDsOwner");
  if (!select) return;
  select.innerHTML = "";

  const pubOpt = document.createElement("option");
  pubOpt.value = "public";
  pubOpt.textContent = "Public (available to all users)";
  select.appendChild(pubOpt);

  const tbody = el("usersTableBody");
  const users = tbody?._users || [];
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `${u.username || u.email} (ID ${u.id})`;
    select.appendChild(opt);
  }

  if (_currentOwnerFilter) {
    select.value = String(_currentOwnerFilter);
  }

  el("addDsName").value = "";
  el("addDsDescription").value = "";

  openModal("addDatasetModal");
}

async function createDataset() {
  const ownerVal = el("addDsOwner").value;
  const isPublic = ownerVal === "public";
  const ownerId = isPublic ? 0 : parseInt(ownerVal, 10);
  const name = el("addDsName").value.trim();
  const description = el("addDsDescription").value.trim();

  if (!name) {
    showToast("Name is required");
    return;
  }
  if (!isPublic && !ownerId) {
    showToast("Please select an owner");
    return;
  }

  const tbody = el("usersTableBody");
  const users = tbody?._users || [];
  const owner = isPublic ? null : users.find((u) => u.id === ownerId);

  const res = await datasetApi("/admin/datasets", {
    method: "POST",
    body: {
      name,
      description: description || null,
      owner_id: ownerId,
      owner_username: isPublic ? "public" : (owner?.username || owner?.email || "unknown"),
      is_public: isPublic,
    },
  });

  if (res.ok || res.status === 201) {
    showToast("Dataset created", "success");
    closeModal("addDatasetModal");
    await loadDatasets(_currentOwnerFilter, _currentOwnerName);
  } else {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Failed to create dataset");
  }
}

// ── Edit Dataset Modal ───────────────────────────────────────────

const DUCKDB_SOURCES = [
  { key: "synthetic", label: "Synthetic" },
  { key: "microcensus", label: "Microcensus" },
];

let _pendingUploadCategory = null;

function renderDatasetFiles(ds) {
  const mgr = el("dsFilesManager");
  if (!mgr) return;
  mgr.innerHTML = "";

  // data_categories is computed live from disk by the backend
  // (synthetic.duckdb -> "synthetic"), so it reflects what's actually present.
  const categories = ds.data_categories || [];
  for (const s of DUCKDB_SOURCES) {
    const present = categories.includes(s.key);
    const row = document.createElement("div");
    row.className = "ds-file-row" + (present ? " is-present" : "");
    row.innerHTML = present
      ? `<span class="ds-file-name"><span class="ds-file-check">✓</span> ${s.label} <code>${s.key}.duckdb</code></span>
         <button type="button" class="ds-file-action" data-cat="${s.key}" data-action="pick-duckdb">Replace</button>`
      : `<span class="ds-file-name ds-file-missing">${s.label}</span>
         <button type="button" class="ds-file-action" data-cat="${s.key}" data-action="pick-duckdb">Browse…</button>`;
    mgr.appendChild(row);
  }

  mgr.querySelectorAll("button[data-action=pick-duckdb]").forEach((b) => {
    b.addEventListener("click", () => triggerDuckdbPicker(b.dataset.cat));
  });
}

function triggerDuckdbPicker(category) {
  _pendingUploadCategory = category;
  const input = el("dsHiddenFileInput");
  if (!input) return;
  input.value = "";
  input.click();
}

function openEditDatasetModal(ds) {
  el("editDsOriginalId").value = ds.id;
  el("editDsId").value = ds.id;
  el("editDsName").value = ds.name || "";
  el("editDsDescription").value = ds.description || "";
  el("editDsStatus").value = ds.status || "inactive";
  el("editDsPublic").checked = !!ds.is_public;

  renderDatasetFiles(ds);

  openModal("editDatasetModal");
}

async function uploadDuckdbFile(category, file) {
  const dsid = el("editDsOriginalId").value;
  if (!file.name.toLowerCase().endsWith(".duckdb")) {
    showToast("Only .duckdb files are accepted");
    return;
  }

  const mgr = el("dsFilesManager");
  const btn = mgr?.querySelector(`button[data-cat="${category}"]`);
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

  const form = new FormData();
  form.append("file", file);
  // Multipart upload — must NOT set Content-Type so the browser adds the boundary.
  const url = `${CONFIG.DATASET_API_BASE}/admin/datasets/${dsid}/upload/${category}`;
  const doFetch = () =>
    fetch(url, { method: "POST", credentials: "include", body: form });

  try {
    let res = await doFetch();
    if (res.status === 401) {
      const ok = await refresh().catch(() => false);
      if (ok) res = await doFetch();
    }
    if (res.ok) {
      const label = DUCKDB_SOURCES.find((s) => s.key === category)?.label || category;
      showToast(`${label} DuckDB uploaded ✓`, "success");
      await loadDatasets(_currentOwnerFilter, _currentOwnerName);
      // Re-render the manager from the refreshed flags (restores button state)
      const updated = _allDatasets.find((d) => String(d.id) === String(dsid));
      if (updated) renderDatasetFiles(updated);
    } else {
      const err = await readJsonOrText(res);
      showToast(err?.detail || "Upload failed");
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  } catch (err) {
    console.warn("uploadDuckdb error:", err);
    showToast("Upload failed");
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function saveDataset() {
  const originalId = el("editDsOriginalId").value;
  const newId = parseInt(el("editDsId").value, 10);
  const name = el("editDsName").value.trim();
  const description = el("editDsDescription").value.trim();
  const dsStatus = el("editDsStatus").value;
  const isPublic = el("editDsPublic").checked;

  if (!name) {
    showToast("Name is required");
    return;
  }
  if (!newId || newId < 1) {
    showToast("ID must be a positive number");
    return;
  }

  const body = { name, description: description || null, status: dsStatus, is_public: isPublic };
  if (newId !== parseInt(originalId, 10)) {
    body.id = newId;
  }

  const res = await datasetApi(`/admin/datasets/${originalId}`, {
    method: "PATCH",
    body,
  });

  if (res.ok) {
    showToast("Dataset updated", "success");
    closeModal("editDatasetModal");
    await loadDatasets(_currentOwnerFilter, _currentOwnerName);
  } else {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Update failed");
  }
}

// ── Back to App ───────────────────────────────────────────────────

function getSourceApp() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  if (from === "dashboard") return { path: "/dashboard/", tab: "dashboard-tab", label: "Dashboard" };
  return { path: "/webmap/", tab: "webmap-tab", label: "Webmap" };
}

function attachBackToApp() {
  const btn = el("backToAppBtn");
  if (!btn) return;
  const source = getSourceApp();
  btn.textContent = "Back to " + source.label;
  btn.addEventListener("click", () => {
    const w = window.open("", source.tab);
    if (!w || !w.location.href || w.location.href === "about:blank") {
      window.open(source.path, source.tab);
    } else {
      w.focus();
    }
  });
}

// ── Logout ───────────────────────────────────────────────────────

function attachLogout() {
  const btn = el("adminLogoutBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api("/logout", { method: "POST", body: {}, allow401: true });
    } catch { /* ignore */ }
    window.location.assign("/authentification/");
  });
}

// ── Init ─────────────────────────────────────────────────────────

(async function init() {
  let userData;
  try {
    let meRes = await api("/me", { method: "GET", allow401: true });

    if (!meRes.ok && meRes.status === 401) {
      const ok = await refresh().catch(() => false);
      if (ok) {
        meRes = await api("/me", { method: "GET", allow401: true });
      }
    }

    if (!meRes.ok) {
      window.location.assign("/authentification/");
      return;
    }

    userData = await meRes.json();

    if (!userData.admin && !userData.dev) {
      window.location.assign("/authentification/");
      return;
    }
  } catch (err) {
    console.error("Admin auth check failed:", err);
    window.location.assign("/authentification/");
    return;
  }

  attachLogout();
  attachBackToApp();

  try { await loadUsers(userData); } catch (err) {
    console.warn("loadUsers failed:", err);
    showToast("Failed to load users");
  }

  try { await loadDatasets(); } catch (err) {
    console.warn("loadDatasets failed:", err);
    showToast("Failed to load datasets");
  }

  const clearBtn = el("clearDatasetFilter");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => loadDatasets());
  }

  const saveBtn = el("saveUserBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveUser);
  }

  const addDsBtn = el("addDatasetBtn");
  if (addDsBtn) {
    addDsBtn.addEventListener("click", openAddDatasetModal);
  }

  const createDsBtn = el("createDatasetBtn");
  if (createDsBtn) {
    createDsBtn.addEventListener("click", createDataset);
  }

  const saveDsBtn = el("saveDatasetBtn");
  if (saveDsBtn) {
    saveDsBtn.addEventListener("click", saveDataset);
  }

  const hiddenFile = el("dsHiddenFileInput");
  if (hiddenFile) {
    hiddenFile.addEventListener("change", () => {
      const file = hiddenFile.files?.[0];
      if (file && _pendingUploadCategory) {
        uploadDuckdbFile(_pendingUploadCategory, file);
      }
      _pendingUploadCategory = null;
    });
  }
})();

// ═══════════════════════════════════════════════════════════════════
// Ops: services overview, restarts, logs, environment editor
// ═══════════════════════════════════════════════════════════════════

async function opsApi(path, { method = "GET", body = null } = {}) {
  const opts = {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : null,
  };
  try {
    let res = await fetch(CONFIG.OPS_API_BASE + path, opts);
    if (res.status === 401) {
      const ok = await refresh().catch(() => false);
      if (ok) res = await fetch(CONFIG.OPS_API_BASE + path, opts);
    }
    return res;
  } catch {
    return new Response(JSON.stringify({ detail: "Ops service unreachable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Services tab ─────────────────────────────────────────────────

function _uptime(startedAt) {
  if (!startedAt) return "-";
  const secs = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  if (secs < 129600) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

let _servicesLoadId = 0;

async function loadServices() {
  const tbody = el("servicesTableBody");
  if (!tbody) return;
  const loadId = ++_servicesLoadId;
  tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">Loading…</td></tr>';

  // Phase 1: fast list without stats — renders immediately.
  const res = await opsApi("/services");
  if (loadId !== _servicesLoadId) return;
  if (!res.ok) {
    const err = await readJsonOrText(res);
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-center">${esc(err?.detail || "Ops service unavailable")}</td></tr>`;
    return;
  }
  const data = await res.json();
  _renderServiceRows(tbody, data.services);

  // Phase 2: CPU/MEM arrive ~1–2s later (Docker samples CPU) and are
  // filled into the existing rows without re-rendering.
  opsApi("/services?stats=1").then(async (res2) => {
    if (loadId !== _servicesLoadId || !res2.ok) return;
    const d2 = await res2.json();
    for (const s of d2.services) {
      const cpuCell = tbody.querySelector(`[data-svc-cpu="${CSS.escape(s.service)}"]`);
      const memCell = tbody.querySelector(`[data-svc-mem="${CSS.escape(s.service)}"]`);
      if (cpuCell) cpuCell.textContent = s.cpu_percent != null ? s.cpu_percent + "%" : "-";
      if (memCell) memCell.textContent = s.mem_used_mb != null ? Math.round(s.mem_used_mb) + " MB" : "-";
    }
  }).catch(() => {});
}

function _renderServiceRows(tbody, services) {
  tbody.innerHTML = "";
  for (const s of services) {
    const running = s.status === "running";
    const dot = running
      ? (s.health === "unhealthy" ? "dot-warn" : "dot-ok")
      : "dot-down";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="status-dot ${dot}"></span> <strong>${esc(s.service)}</strong></td>
      <td>${esc(s.status)}</td>
      <td>${esc(s.health || "-")}</td>
      <td data-svc-cpu="${esc(s.service)}"><span class="stats-pending">…</span></td>
      <td data-svc-mem="${esc(s.service)}"><span class="stats-pending">…</span></td>
      <td>${running ? _uptime(s.started_at) : "-"}</td>
      <td>
        <div class="actions">
          <button class="btn btn-outline btn-sm" data-svc="${esc(s.service)}" data-action="svc-logs">Logs</button>
          ${s.restartable ? `<button class="btn btn-outline btn-sm" data-svc="${esc(s.service)}" data-action="svc-restart">Restart</button>` : ""}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-action=svc-restart]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const svc = btn.dataset.svc;
      if (!confirm(`Restart ${svc}?`)) return;
      btn.disabled = true;
      btn.textContent = "…";
      const res = await opsApi(`/services/${svc}/restart`, { method: "POST" });
      if (res.ok) {
        showToast(`${svc} restarted`, "success");
        setTimeout(loadServices, 1200);
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Restart failed");
        btn.disabled = false;
        btn.textContent = "Restart";
      }
    });
  });

  tbody.querySelectorAll("button[data-action=svc-logs]").forEach((btn) => {
    btn.addEventListener("click", () => openLogsModal(btn.dataset.svc));
  });
}

let _logsService = null;
let _logsSince = null;     // server timestamp of the last received chunk
let _logsTimer = null;
let _logsBusy = false;

function _logsAtBottom(pre) {
  return pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
}

async function _fetchLogs(reset = false) {
  const pre = el("logsPre");
  if (!pre || !_logsService || _logsBusy) return;
  _logsBusy = true;
  try {
    if (reset) {
      _logsSince = null;
      pre.textContent = "Loading…";
    }
    const q = _logsSince ? `?since=${_logsSince}` : "?tail=300";
    const res = await opsApi(`/services/${_logsService}/logs${q}`);
    if (!res.ok) {
      const err = await readJsonOrText(res);
      if (!_logsSince) pre.textContent = err?.detail || "Failed to load logs";
      return;
    }
    const data = await res.json();
    const follow = _logsAtBottom(pre) || !_logsSince;
    if (_logsSince) {
      if (data.logs) pre.textContent += data.logs;   // append only the new lines
    } else {
      pre.textContent = data.logs || "(no output yet)";
    }
    _logsSince = data.now;                            // next poll: only newer lines
    // Cap the buffer so an hours-open modal doesn't grow unbounded
    if (pre.textContent.length > 400000) {
      pre.textContent = pre.textContent.slice(-300000);
    }
    if (follow) pre.scrollTop = pre.scrollHeight;     // stick to bottom unless the user scrolled up
  } finally {
    _logsBusy = false;
  }
}

function _stopLogsFollow() {
  if (_logsTimer) { clearInterval(_logsTimer); _logsTimer = null; }
}

function openLogsModal(service) {
  _logsService = service;
  const name = el("logsServiceName");
  if (name) name.textContent = service;
  openModal("logsModal");
  _fetchLogs(true);
  // Live follow: poll for new lines while the modal is open; the interval
  // shuts itself down as soon as the modal is closed (any close path).
  _stopLogsFollow();
  _logsTimer = setInterval(() => {
    if (!el("logsModal")?.classList.contains("visible")) {
      _stopLogsFollow();
      return;
    }
    _fetchLogs();
  }, 2000);
}

// ── Environment tab ──────────────────────────────────────────────

let _envOriginal = {};

async function loadEnv() {
  const tbody = el("envTableBody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center">Loading…</td></tr>';

  const res = await opsApi("/env");
  if (!res.ok) {
    const err = await readJsonOrText(res);
    tbody.innerHTML = `<tr><td colspan="4" class="text-muted text-center">${esc(err?.detail || "Ops service unavailable")}</td></tr>`;
    return;
  }
  const data = await res.json();
  tbody.innerHTML = "";
  _envOriginal = {};

  for (const k of data.keys) {
    _envOriginal[k.key] = k.value;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${esc(k.key)}</code></td>
      <td><input class="form-input env-input" data-envkey="${esc(k.key)}"
                 type="${k.secret ? "password" : "text"}"
                 value="${esc(k.value)}" placeholder="(unset)" /></td>
      <td class="text-muted">${esc(k.hint)}</td>
      <td>${(k.restart || []).map((s) => `<span class="badge badge-restart">${esc(s)}</span>`).join(" ")}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function saveEnv() {
  const values = {};
  $$(".env-input").forEach((inp) => {
    const key = inp.dataset.envkey;
    if (inp.value !== _envOriginal[key]) values[key] = inp.value;
  });
  if (!Object.keys(values).length) {
    showToast("Nothing changed", "success");
    return;
  }
  const res = await opsApi("/env", { method: "PUT", body: { values } });
  if (!res.ok) {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Save failed");
    return;
  }
  const data = await res.json();
  const restart = data.restart || [];
  showToast(
    restart.length
      ? `Saved. Restart to apply: ${restart.join(", ")} (Services tab)`
      : "Saved.",
    "success", 7000
  );
  loadEnv();
}

// ── Dataset access (grants) ──────────────────────────────────────

let _accessDs = null;

async function openAccessModal(ds) {
  _accessDs = ds;
  const name = el("accessDsName");
  if (name) name.textContent = ds.name;
  openModal("accessModal");
  await _renderGrants();
}

function _userLabel(uid) {
  const users = el("usersTableBody")?._users || [];
  const u = users.find((x) => x.id === uid);
  return u ? `${u.username || u.email} (ID ${uid})` : `User ${uid}`;
}

async function _renderGrants() {
  const tbody = el("grantsTableBody");
  const select = el("grantUserSelect");
  if (!tbody || !_accessDs) return;
  tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center">Loading…</td></tr>';

  const res = await datasetApi(`/datasets/${_accessDs.id}/grants`);
  if (!res.ok) {
    const err = await readJsonOrText(res);
    tbody.innerHTML = `<tr><td colspan="3" class="text-muted text-center">${esc(err?.detail || "Failed to load")}</td></tr>`;
    return;
  }
  const grants = await res.json();
  tbody.innerHTML = grants.length ? "" :
    '<tr><td colspan="3" class="text-muted text-center">No one else has access yet.</td></tr>';

  for (const g of grants) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(_userLabel(g.user_id))}</td>
      <td><span class="badge ${g.role === "editor" ? "badge-editor" : "badge-viewer"}">${esc(g.role)}</span></td>
      <td class="text-nowrap">
        <button class="btn btn-danger btn-sm" data-guid="${g.user_id}" data-action="revoke-grant">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-action=revoke-grant]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const res = await datasetApi(
        `/datasets/${_accessDs.id}/grants/${btn.dataset.guid}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        showToast("Access removed", "success");
        _renderGrants();
      } else {
        const err = await readJsonOrText(res);
        showToast(err?.detail || "Failed to remove");
      }
    });
  });

  // Fill the user picker: everyone except owner + already-granted
  if (select) {
    const users = el("usersTableBody")?._users || [];
    const taken = new Set(grants.map((g) => g.user_id));
    select.innerHTML = "";
    users
      .filter((u) => u.id !== _accessDs.owner_id && !taken.has(u.id))
      .forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.username || u.email} (ID ${u.id})`;
        select.appendChild(opt);
      });
  }
}

// ── Wiring for the new controls ──────────────────────────────────

el("refreshServicesBtn")?.addEventListener("click", loadServices);
el("saveEnvBtn")?.addEventListener("click", saveEnv);
el("logsRefreshBtn")?.addEventListener("click", () => _fetchLogs(true));
el("grantAddBtn")?.addEventListener("click", async () => {
  const uid = parseInt(el("grantUserSelect")?.value, 10);
  const role = el("grantRoleSelect")?.value || "viewer";
  if (!uid || !_accessDs) {
    showToast("Pick a user first");
    return;
  }
  const res = await datasetApi(`/datasets/${_accessDs.id}/grants`, {
    method: "POST", body: { user_id: uid, role },
  });
  if (res.ok || res.status === 201) {
    showToast("Access granted", "success");
    _renderGrants();
  } else {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Failed to grant access");
  }
});
