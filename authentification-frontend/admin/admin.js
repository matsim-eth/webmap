const CONFIG = {
  API_BASE: "/authentification/backend",
  DATASET_API_BASE: "/backend/datasets",
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

function switchAdminTab(tabName) {
  $$(".admin-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tabName)
  );
  el("users-pane")?.classList.toggle("active", tabName === "users");
  el("datasets-pane")?.classList.toggle("active", tabName === "datasets");
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

  const users = data.users.sort((a, b) => {
    const aSystem = isSystemUser(a.email) ? 0 : 1;
    const bSystem = isSystemUser(b.email) ? 0 : 1;
    if (aSystem !== bSystem) return aSystem - bSystem;
    return a.id - b.id;
  });

  for (const u of users) {
    const isSys = isSystemUser(u.email);
    const tr = document.createElement("tr");
    if (isSys) tr.classList.add("system-row");

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
      <td>
        ${!isSys ? `
          <div class="actions">
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
          <button class="btn btn-outline btn-sm" data-dsid="${ds.id}" data-action="edit-ds">Edit</button>
          <button class="btn btn-danger btn-sm" data-dsid="${ds.id}" data-action="delete-ds">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

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
      if (!confirm("Permanently delete this dataset and all its files?")) return;
      const dsid = btn.dataset.dsid;
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

function openEditDatasetModal(ds) {
  el("editDsOriginalId").value = ds.id;
  el("editDsId").value = ds.id;
  el("editDsName").value = ds.name || "";
  el("editDsDescription").value = ds.description || "";
  el("editDsStatus").value = ds.status || "inactive";
  el("editDsPublic").checked = !!ds.is_public;

  openModal("editDatasetModal");
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
})();
