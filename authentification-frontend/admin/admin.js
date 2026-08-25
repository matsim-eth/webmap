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
    const defaultBadge = ds.is_default
      ? ' <span class="badge badge-dark" title="System-wide default dataset">DEFAULT</span>'
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${ds.id}</code></td>
      <td>${esc(ds.name)}</td>
      <td>${esc(ds.description || "-")}</td>
      <td>${esc(ds.owner_username || "")} <span class="text-muted">(${ds.owner_id})</span></td>
      <td><span class="badge ${statusCls}">${esc(ds.status)}</span>${defaultBadge}</td>
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

  // Always fetch UNFILTERED and narrow client-side. The owner filter is a view
  // over the tables, but the default-dataset dropdown is a system-wide setting
  // that must see every dataset: filtering server-side (?owner_id=) drops the
  // current default from the payload whenever it belongs to another owner, and
  // the dropdown then reads "None" even though a default is set. Admin dataset
  // counts are small, so the saved bytes aren't worth that failure mode.
  const url = "/admin/datasets";

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

  // Owner filter applied here, not server-side — see the note on `url` above.
  const visible = ownerFilter
    ? _allDatasets.filter((ds) => String(ds.owner_id) === String(ownerFilter))
    : _allDatasets;

  const publicDatasets = visible.filter((ds) => ds.is_public);
  const privateDatasets = visible.filter((ds) => !ds.is_public);

  _renderDatasetRows(el("publicDatasetsBody"), publicDatasets, ownerFilter, ownerName);
  _renderDatasetRows(el("privateDatasetsBody"), privateDatasets, ownerFilter, ownerName);
  renderDefaultDatasetSelect();
  _checkTableJobStatuses(visible);
}

// ── Inline job progress in dataset tables ───────────────────────

let _tableJobTimers = new Map();  // dsid -> intervalId

function _stopAllTableJobPolls() {
  for (const t of _tableJobTimers.values()) clearInterval(t);
  _tableJobTimers.clear();
}

function _checkTableJobStatuses(datasets) {
  _stopAllTableJobPolls();
  for (const ds of datasets) {
    _checkTableJob(ds.id, "ingest");
    _checkTableJob(ds.id, "rezone");
  }
}

async function _checkTableJob(dsid, jobType) {
  const url = jobType === "ingest"
    ? `/datasets/${dsid}/ingest/status`
    : `/datasets/${dsid}/rezone/status`;
  const res = await datasetApi(url);
  if (!res.ok) return;
  const job = await res.json().catch(() => null);
  if (!job || job.state !== "running") return;
  _showTableJobProgress(dsid, jobType, job);
  _startTableJobPoll(dsid, jobType);
}

function _showTableJobProgress(dsid, jobType, job) {
  const key = `${jobType}-${dsid}`;
  const rowId = `ds-job-row-${key}`;

  // Find the dataset's main row in either table body
  let mainRow = null;
  for (const tbodyId of ["publicDatasetsBody", "privateDatasetsBody"]) {
    const tbody = el(tbodyId);
    if (!tbody) continue;
    const btn = tbody.querySelector(`button[data-dsid="${dsid}"]`);
    if (btn) { mainRow = btn.closest("tr"); break; }
  }
  if (!mainRow) return;

  let progressRow = document.getElementById(rowId);
  if (!progressRow) {
    progressRow = document.createElement("tr");
    progressRow.id = rowId;
    progressRow.className = "ds-job-progress-row";
    mainRow.after(progressRow);
  }

  const label = jobType === "ingest" ? "Processing" : "Re-zoning";
  const stepText = job.step || "";
  const stepIndex = job.step_index || 0;
  const nSteps = job.n_steps || 14;
  const pct = typeof job.progress === "number"
    ? Math.round((job.progress <= 1 ? job.progress : job.progress / 100) * 100)
    : null;
  const pctWidth = pct !== null ? `${pct}%` : "100%";
  const indeterminate = pct === null;
  const stepLabel = stepIndex > 0 ? `Step ${stepIndex}/${nSteps}` : "";
  const detail = stepText.split(":").slice(1).join(":").trim();
  const stepName = stepText.split(":")[0].trim();

  progressRow.innerHTML = `
    <td colspan="7" class="ds-job-cell">
      <div class="ds-job-inline">
        <span class="ds-job-label">${label}</span>
        <span class="ds-job-step">${esc(stepName)}${detail ? ": " + esc(detail) : ""}</span>
        <span class="ds-job-counter">${stepLabel}${pct !== null ? " · " + pct + "%" : ""}</span>
      </div>
      <div class="ds-job-bar">
        <div class="ds-job-bar-fill${indeterminate ? " is-indeterminate" : ""}" style="width:${pctWidth}"></div>
      </div>
    </td>
  `;
}

function _startTableJobPoll(dsid, jobType) {
  const key = `${jobType}-${dsid}`;
  if (_tableJobTimers.has(key)) return;

  const url = jobType === "ingest"
    ? `/datasets/${dsid}/ingest/status`
    : `/datasets/${dsid}/rezone/status`;

  const timer = setInterval(async () => {
    const res = await datasetApi(url);
    if (!res.ok) return;
    const job = await res.json().catch(() => null);
    if (!job) return;

    if (job.state === "running") {
      _showTableJobProgress(dsid, jobType, job);
      return;
    }

    // Job finished — remove the progress row and stop polling
    clearInterval(timer);
    _tableJobTimers.delete(key);
    const rowId = `ds-job-row-${key}`;
    document.getElementById(rowId)?.remove();

    if (job.state === "done") {
      const label = jobType === "ingest" ? "MATSim import" : "Re-zone";
      showToast(`${label} complete for dataset ${dsid}`, "success");
      await loadDatasets(_currentOwnerFilter, _currentOwnerName);
    } else {
      const label = jobType === "ingest" ? "MATSim import" : "Re-zone";
      showToast(`${label} failed for dataset ${dsid}: ${job.detail || "unknown error"}`);
    }
  }, 4000);

  _tableJobTimers.set(key, timer);
}

// ── Default dataset ──────────────────────────────────────────────

/**
 * Populate the default-dataset dropdown from the loaded dataset list.
 *
 * Eligible options are public + active only, matching the backend's guard in
 * PUT /admin/datasets/default: a private default would 403 for everyone but its
 * owner, and an inactive one 403s for everyone, so it must not be offered here.
 *
 * Rebuilt from `_allDatasets` on every load so the "DEFAULT" badge in the table
 * and the dropdown selection can never drift apart. `_allDatasets` is always the
 * UNFILTERED list (loadDatasets narrows by owner only for the tables), which is
 * what lets this see a default owned by someone other than the filtered user.
 */
function renderDefaultDatasetSelect() {
  const select = el("defaultDatasetSelect");
  if (!select) return;

  const eligible = _allDatasets.filter((ds) => ds.is_public && ds.status === "active");
  const current = _allDatasets.find((ds) => ds.is_default) || null;

  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (lowest ID)";
  select.appendChild(noneOpt);

  for (const ds of eligible) {
    const opt = document.createElement("option");
    opt.value = String(ds.id);
    opt.textContent = `${ds.name} (ID ${ds.id})`;
    select.appendChild(opt);
  }

  // A default that is no longer eligible (demoted to private/inactive by another
  // admin between loads) still has to be selectable, or the control would claim
  // "None" while the backend still holds it.
  if (current && !eligible.some((ds) => ds.id === current.id)) {
    const opt = document.createElement("option");
    opt.value = String(current.id);
    opt.textContent = `${current.name} (ID ${current.id})`;
    select.appendChild(opt);
  }

  select.value = current ? String(current.id) : "";
  select._lastValue = select.value;
  // Cleared here, then re-set by saveDefaultDataset *after* its reload finishes —
  // setting it before that reload wiped the confirmation within the same tick.
  setDefaultDatasetStatus("");
}

function setDefaultDatasetStatus(msg) {
  const node = el("defaultDatasetStatus");
  if (node) node.textContent = msg;
}

async function saveDefaultDataset(select) {
  const raw = select.value;
  const previous = select._lastValue ?? "";
  select.disabled = true;
  setDefaultDatasetStatus("Saving…");

  const res = await datasetApi("/admin/datasets/default", {
    method: "PUT",
    body: { dataset_id: raw === "" ? null : parseInt(raw, 10) },
  });
  select.disabled = false;

  if (!res.ok) {
    const err = await readJsonOrText(res);
    // Revert to the last known-good value so the control never shows a default
    // the backend rejected.
    select.value = previous;
    setDefaultDatasetStatus("");
    showToast(err?.detail || "Failed to set default dataset");
    return;
  }

  select._lastValue = raw;
  // Reload so the DEFAULT badge moves to the new row, THEN report — the reload
  // re-renders the select and resets its status line.
  await loadDatasets(_currentOwnerFilter, _currentOwnerName);
  setDefaultDatasetStatus(raw === "" ? "Default cleared." : "Saved.");
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

async function openEditDatasetModal(ds) {
  el("editDsOriginalId").value = ds.id;
  el("editDsId").value = ds.id;
  el("editDsName").value = ds.name || "";
  el("editDsDescription").value = ds.description || "";
  el("editDsStatus").value = ds.status || "inactive";
  el("editDsPublic").checked = !!ds.is_public;

  renderDatasetFiles(ds);
  // Reset synchronously (kills any poll left over from the previously opened
  // dataset), then ask in the background whether a build is already running.
  resetIngestSection();
  checkIngestJob(ds.id);
  // Load the study-area section BEFORE showing the modal so it doesn't pop in
  // late; a slow/unreachable backend is capped at 2s (the section then just
  // appears when the fetch settles, as before). Cached per dataset id.
  await Promise.race([
    loadRezoneOptions(ds),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);

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
      // A new duckdb can change what re-zoning is possible.
      _rezoneOptsCache.delete(String(dsid));
      if (updated) loadRezoneOptions(updated);
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

// ── Study-area re-zoning ─────────────────────────────────────────
// Derives a NEW dataset zoned by a smaller admin level (municipalities /
// districts) from the dataset's own polygons — see dataset-backend/rezone.py.

const ZONE_LEVELS = [
  { key: "gemeinde", label: "Municipalities" },
  { key: "bezirk", label: "Districts" },
];

let _rezonePollTimer = null;

// Options per dataset id — so reopening the modal renders the section
// instantly instead of popping in after the fetch. Invalidated on upload.
const _rezoneOptsCache = new Map();

async function loadRezoneOptions(ds) {
  const section = el("dsRezoneSection");
  if (!section) return;
  section.hidden = true;
  clearInterval(_rezonePollTimer);
  hideRezoneConfirm();
  const statusEl = el("dsRezoneStatus");
  if (statusEl) statusEl.hidden = true;
  if (!(ds.data_categories || []).includes("synthetic")) return;

  let opts = _rezoneOptsCache.get(String(ds.id));
  if (!opts) {
    const res = await datasetApi(`/datasets/${ds.id}/rezone/options`);
    if (!res.ok) return; // not re-zonable (v1 dataset, no hot_polygons, …)
    opts = await res.json().catch(() => null);
    if (opts) _rezoneOptsCache.set(String(ds.id), opts);
  }
  const levels = (opts?.zone_types || [])
    .map((t) => ZONE_LEVELS.find((z) => z.key === t))
    .filter(Boolean);
  if (!levels.length) return;

  el("dsRezoneLevel").innerHTML = levels
    .map((l) => `<option value="${l.key}">${l.label}</option>`)
    .join("");
  el("dsRezoneCanton").innerHTML =
    `<option value="">Whole area</option>` +
    (opts.cantons || [])
      .map((c) => `<option value="${c.id}">${c.name}</option>`)
      .join("");
  const cur = opts.current || {};
  el("dsRezoneCurrent").textContent =
    `Current study area: ${cur.name || "Switzerland"} (${cur.primary_zone_type || "canton"} zones)`;
  section.hidden = false;
}

function _selectedText(sel) {
  return sel?.selectedOptions?.[0]?.textContent?.trim() || "";
}

function showRezoneConfirm() {
  const canton = _selectedText(el("dsRezoneCanton"));
  const level = _selectedText(el("dsRezoneLevel")).toLowerCase();
  const area = el("dsRezoneCanton").value ? `canton ${canton}` : "the whole study area";
  el("dsRezoneConfirmText").innerHTML =
    `Create a <strong>new</strong> dataset for <strong>${area}</strong>, zoned by ` +
    `<strong>${level}</strong>? The source dataset stays unchanged. ` +
    `This takes a few minutes.`;
  el("dsRezoneConfirm").hidden = false;
  const btn = el("dsRezoneBtn");
  if (btn) btn.disabled = true;
}

function hideRezoneConfirm() {
  const confirmEl = el("dsRezoneConfirm");
  if (confirmEl) confirmEl.hidden = true;
  const btn = el("dsRezoneBtn");
  if (btn) { btn.disabled = false; btn.textContent = "Create re-zoned copy…"; }
}

async function startRezone() {
  const dsid = el("editDsOriginalId").value;
  const cantonRaw = el("dsRezoneCanton").value;
  const body = {
    zone_type: el("dsRezoneLevel").value,
    canton_id: cantonRaw ? parseInt(cantonRaw, 10) : null,
  };
  hideRezoneConfirm();
  const btn = el("dsRezoneBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }

  const res = await datasetApi(`/datasets/${dsid}/rezone`, { method: "POST", body });
  if (!res.ok) {
    const err = await readJsonOrText(res);
    showToast(err?.detail || "Failed to start re-zone");
    if (btn) { btn.disabled = false; btn.textContent = "Create re-zoned copy…"; }
    return;
  }
  const { dataset_id: newId, name } = await res.json();
  showToast(`Re-zoning into “${name}”…`, "success");
  pollRezone(newId, btn);
}

function pollRezone(newId, btn) {
  const statusEl = el("dsRezoneStatus");
  if (statusEl) statusEl.hidden = false;
  clearInterval(_rezonePollTimer);

  // Show progress in the dataset table too (the new dataset may not be in
  // the table yet, but _startTableJobPoll will pick it up once loadDatasets
  // adds the row on its next reload).
  _showTableJobProgress(newId, "rezone", { step: "starting", step_index: 0, n_steps: 13, progress: 0 });
  _startTableJobPoll(newId, "rezone");

  const tick = async () => {
    const res = await datasetApi(`/datasets/${newId}/rezone/status`);
    if (!res.ok) return; // transient — keep polling
    const job = await res.json().catch(() => null);
    if (!job) return;
    if (job.state === "running") {
      const stepInfo = job.step_index && job.n_steps
        ? ` (step ${job.step_index}/${job.n_steps})`
        : "";
      if (statusEl) statusEl.textContent = `Re-zoning… ${job.step || ""}${stepInfo}`;
      return;
    }
    clearInterval(_rezonePollTimer);
    if (btn) { btn.disabled = false; btn.textContent = "Create re-zoned copy…"; }
    if (job.state === "done") {
      if (statusEl) statusEl.textContent =
        "Done — new dataset created (inactive). Set it to active to publish.";
      showToast("Re-zoned dataset ready ✓", "success");
      await loadDatasets(_currentOwnerFilter, _currentOwnerName);
    } else {
      if (statusEl) statusEl.textContent = `Failed: ${job.detail || "unknown error"}`;
      showToast("Re-zone failed");
    }
  };
  _rezonePollTimer = setInterval(tick, 4000);
  tick();
}

// ── Import from MATSim (in-app ingest) ───────────────────────────
// Uploads a run's raw outputs in ONE multipart POST and then polls the
// background build — see dataset-backend/ingest.py. Only builds
// synthetic.duckdb; microcensus stays a prebuilt .duckdb upload.

const GB = 1024 * 1024 * 1024;
const INGEST_WARN_BYTES = 1 * GB;   // long build ahead — warn, still allowed
const INGEST_MAX_BYTES = 2 * GB;    // server refuses (413) — block here first

const INGEST_INPUTS = [
  { key: "trips",            label: "Trips CSV",         accept: ".csv",           required: true,  hint: "eqasim_trips.csv" },
  { key: "activities",       label: "Activities CSV",    accept: ".csv",           required: true,  hint: "eqasim_activities.csv" },
  { key: "persons",          label: "Persons",           accept: ".parquet,.csv",  required: true,  hint: "persons.parquet / .csv" },
  { key: "network",          label: "Network",           accept: ".gz",            required: true,  hint: "output_network.xml.gz" },
  { key: "events",           label: "Events",            accept: ".gz",            required: true,  hint: "output_events.xml.gz" },
  { key: "transit_schedule", label: "Transit schedule",  accept: ".gz",            required: true,  hint: "output_transitSchedule.xml.gz" },
  { key: "plans",            label: "Plans",             accept: ".gz",            required: false, hint: "output_plans.xml.gz (optional)" },
  { key: "households",       label: "Households",        accept: ".parquet,.csv",  required: false, hint: "households.parquet / .csv (optional)" },
];

let _ingestFiles = {};          // key -> File
let _ingestZipFile = null;      // File (zip mode)
let _ingestMode = "files";      // "files" | "zip"
let _ingestBlocked = false;     // events file over the hard limit
let _ingestPollTimer = null;
let _ingestStartedAt = null;

function _humanSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 || n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function _humanElapsed(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function renderIngestFiles() {
  const mgr = el("dsIngestFiles");
  if (!mgr) return;
  mgr.innerHTML = "";

  for (const spec of INGEST_INPUTS) {
    const file = _ingestFiles[spec.key];
    const row = document.createElement("div");
    row.className = "ds-file-row" + (file ? " is-present" : "");
    row.innerHTML = file
      ? `<span class="ds-file-name"><span class="ds-file-check">✓</span> ${spec.label}
           <code>${esc(file.name)}</code> <code>${_humanSize(file.size)}</code></span>
         <button type="button" class="ds-file-action" data-ingest-key="${spec.key}">Change…</button>`
      : `<span class="ds-file-name ds-file-missing">${spec.label}
           <code>${esc(spec.hint)}</code></span>
         <button type="button" class="ds-file-action" data-ingest-key="${spec.key}">Browse…</button>`;
    mgr.appendChild(row);
  }

  mgr.querySelectorAll("button[data-ingest-key]").forEach((b) => {
    b.addEventListener("click", () => pickIngestFile(b.dataset.ingestKey));
  });
}

function switchIngestMode(mode) {
  _ingestMode = mode;
  $$(".ds-ingest-mode-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.ingestMode === mode)
  );
  el("dsIngestModeFiles")?.classList.toggle("active", mode === "files");
  el("dsIngestModeZip")?.classList.toggle("active", mode === "zip");
  updateIngestWarning();
}

function renderIngestZipFile() {
  const mgr = el("dsIngestZipFile");
  if (!mgr) return;
  mgr.innerHTML = "";

  const row = document.createElement("div");
  row.className = "ds-file-row" + (_ingestZipFile ? " is-present" : "");
  row.innerHTML = _ingestZipFile
    ? `<span class="ds-file-name"><span class="ds-file-check">✓</span> ZIP Archive
         <code>${esc(_ingestZipFile.name)}</code> <code>${_humanSize(_ingestZipFile.size)}</code></span>
       <button type="button" class="ds-file-action" id="dsIngestZipPick">Change…</button>`
    : `<span class="ds-file-name ds-file-missing">ZIP Archive
         <code>webmap_inputs_*.zip</code></span>
       <button type="button" class="ds-file-action" id="dsIngestZipPick">Browse…</button>`;
  mgr.appendChild(row);

  el("dsIngestZipPick")?.addEventListener("click", pickIngestZip);
}

function pickIngestZip() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) _ingestZipFile = file;
    renderIngestZipFile();
    updateIngestWarning();
  });
  input.click();
}

function pickIngestFile(key) {
  const spec = INGEST_INPUTS.find((s) => s.key === key);
  if (!spec) return;
  // Built on demand: a per-field <input type=file> in the modal would be seven
  // more controls to keep in sync with INGEST_INPUTS.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = spec.accept;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) _ingestFiles[key] = file;
    renderIngestFiles();
    updateIngestWarning();
  });
  input.click();
}

function updateIngestWarning() {
  const warnEl = el("dsIngestWarn");
  const startBtn = el("dsIngestStartBtn");
  const events = _ingestFiles.events;
  _ingestBlocked = false;
  if (!warnEl) return;

  if (events && events.size > INGEST_MAX_BYTES) {
    _ingestBlocked = true;
    warnEl.className = "ds-ingest-warn is-block";
    warnEl.textContent =
      `This file is too large for in-app processing (${_humanSize(events.size)}). ` +
      `Please use the eqasim pipeline's webmap_export stage to generate the DuckDB ` +
      `files, then upload them directly.`;
    warnEl.hidden = false;
  } else if (events && events.size > INGEST_WARN_BYTES) {
    warnEl.className = "ds-ingest-warn";
    warnEl.textContent =
      `Processing may take 30–90 minutes for a 1% sample. You can close this ` +
      `dialog and check back later.`;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
    warnEl.textContent = "";
  }
  if (startBtn) startBtn.disabled = _ingestBlocked;
}

function toggleIngestSection(force) {
  const body = el("dsIngestBody");
  const toggle = el("dsIngestToggle");
  const caret = el("dsIngestCaret");
  if (!body) return;
  const open = force === undefined ? body.hidden : !!force;
  body.hidden = !open;
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (caret) caret.innerHTML = open ? "&#9662;" : "&#9656;";
}

/** Reset the section for a freshly opened modal (synchronous — no fetch). */
function resetIngestSection() {
  clearInterval(_ingestPollTimer);
  _ingestPollTimer = null;
  _ingestFiles = {};
  _ingestZipFile = null;
  _ingestBlocked = false;
  _ingestStartedAt = null;
  toggleIngestSection(false);
  switchIngestMode("files");
  const sr = el("dsIngestSampleRate"); if (sr) sr.value = "";
  const rn = el("dsIngestRunName"); if (rn) rn.value = "";
  const prog = el("dsIngestProgress"); if (prog) prog.hidden = true;
  const fill = el("dsIngestBarFill"); if (fill) fill.style.width = "0%";
  const elapsed = el("dsIngestElapsed"); if (elapsed) elapsed.textContent = "";
  const startBtn = el("dsIngestStartBtn");
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = "Start Processing"; }
  renderIngestFiles();
  renderIngestZipFile();
  updateIngestWarning();
}

/** If a build is already running for this dataset, show its progress at once. */
async function checkIngestJob(dsid) {
  const res = await datasetApi(`/datasets/${dsid}/ingest/status`);
  if (!res.ok) return;                                  // 404 = no job, normal
  const job = await res.json().catch(() => null);
  if (!job || job.state !== "running") return;
  // The admin may have moved on to another dataset while this was in flight.
  if (String(el("editDsOriginalId")?.value) !== String(dsid)) return;
  toggleIngestSection(true);
  pollIngest(dsid);
}

async function startIngest() {
  if (_ingestMode === "zip") return startIngestZip();

  const dsid = el("editDsOriginalId").value;
  const missing = INGEST_INPUTS
    .filter((s) => s.required && !_ingestFiles[s.key])
    .map((s) => s.label);
  if (missing.length) {
    showToast(`Missing required file(s): ${missing.join(", ")}`);
    return;
  }
  if (_ingestBlocked) {
    showToast("Events file too large for in-app processing");
    return;
  }

  const form = new FormData();
  for (const spec of INGEST_INPUTS) {
    const file = _ingestFiles[spec.key];
    if (file) form.append(spec.key, file, file.name);
  }
  const sampleRate = el("dsIngestSampleRate")?.value.trim();
  if (sampleRate) form.append("sample_rate", sampleRate);
  const runName = el("dsIngestRunName")?.value.trim();
  if (runName) form.append("run_name", runName);

  _ingestStartedAt = null;
  const startBtn = el("dsIngestStartBtn");
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = "Uploading…"; }
  const prog = el("dsIngestProgress");
  if (prog) prog.hidden = false;
  const stepEl = el("dsIngestStep");
  const fill = el("dsIngestBarFill");
  if (stepEl) stepEl.textContent = "Uploading…";
  if (fill) fill.style.width = "0%";

  await refresh().catch(() => false);

  const url = `${CONFIG.DATASET_API_BASE}/datasets/${dsid}/ingest`;
  _doIngestUpload(url, form, dsid);
}

async function startIngestZip() {
  const dsid = el("editDsOriginalId").value;
  if (!_ingestZipFile) {
    showToast("Please select a ZIP file");
    return;
  }

  const form = new FormData();
  form.append("zipfile_upload", _ingestZipFile, _ingestZipFile.name);
  const sampleRate = el("dsIngestSampleRate")?.value.trim();
  if (sampleRate) form.append("sample_rate", sampleRate);
  const runName = el("dsIngestRunName")?.value.trim();
  if (runName) form.append("run_name", runName);

  _ingestStartedAt = null;
  const startBtn = el("dsIngestStartBtn");
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = "Uploading…"; }
  const prog = el("dsIngestProgress");
  if (prog) prog.hidden = false;
  const stepEl = el("dsIngestStep");
  const fill = el("dsIngestBarFill");
  if (stepEl) stepEl.textContent = "Uploading…";
  if (fill) fill.style.width = "0%";

  await refresh().catch(() => false);

  const url = `${CONFIG.DATASET_API_BASE}/datasets/${dsid}/ingest/zip`;
  _doIngestUpload(url, form, dsid);
}

function _doIngestUpload(url, form, dsid) {
  const startBtn = el("dsIngestStartBtn");
  const stepEl = el("dsIngestStep");
  const fill = el("dsIngestBarFill");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", url, true);
  xhr.withCredentials = true;

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (stepEl) {
      stepEl.textContent =
        `Uploading… ${pct}% (${_humanSize(e.loaded)} / ${_humanSize(e.total)})`;
    }
  };

  const _failUnlessRunning = async (msg) => {
    // A proxy between the browser and the backend can swallow the 202 and
    // return its own error even though the backend received the request and
    // started processing.  Before declaring failure, check the status
    // endpoint — if the job is running, treat it as success.
    try {
      const res = await datasetApi(`/datasets/${dsid}/ingest/status`);
      if (res.ok) {
        const job = await res.json().catch(() => null);
        if (job && job.state === "running") {
          showToast("Upload complete — processing started", "success");
          if (startBtn) startBtn.textContent = "Processing…";
          pollIngest(dsid);
          return;
        }
      }
    } catch { /* status check failed — fall through to the original error */ }
    showToast(msg);
    if (stepEl) stepEl.textContent = msg;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = "Start Processing"; }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      showToast("Upload complete — processing started", "success");
      if (startBtn) startBtn.textContent = "Processing…";
      pollIngest(dsid);
      return;
    }
    let detail = "";
    try { detail = JSON.parse(xhr.responseText)?.detail || ""; } catch { /* text body */ }
    if (xhr.status === 401) detail = detail || "Session expired — please try again";
    _failUnlessRunning(detail || `Upload failed (HTTP ${xhr.status})`);
  };

  xhr.onerror = () => {
    _failUnlessRunning("Upload failed — network error");
  };

  xhr.send(form);
}

function pollIngest(dsid) {
  const prog = el("dsIngestProgress");
  const stepEl = el("dsIngestStep");
  const fill = el("dsIngestBarFill");
  const elapsedEl = el("dsIngestElapsed");
  const startBtn = el("dsIngestStartBtn");
  if (prog) prog.hidden = false;
  clearInterval(_ingestPollTimer);

  // Also start the table-level poll so the progress bar shows in the
  // dataset list even after the edit modal is closed.
  _showTableJobProgress(dsid, "ingest", { step: "starting", step_index: 0, n_steps: 14, progress: 0 });
  _startTableJobPoll(dsid, "ingest");

  const tick = async () => {
    const res = await datasetApi(`/datasets/${dsid}/ingest/status`);
    if (!res.ok) return;   // transient — keep polling
    const job = await res.json().catch(() => null);
    if (!job) return;

    if (job.started_at && !_ingestStartedAt) {
      const t = new Date(job.started_at).getTime();
      if (!Number.isNaN(t)) _ingestStartedAt = t;
    }
    if (elapsedEl && _ingestStartedAt) {
      elapsedEl.textContent = `Elapsed ${_humanElapsed(Date.now() - _ingestStartedAt)}`;
    }

    if (job.state === "running") {
      if (stepEl) stepEl.textContent = `Processing… ${job.step || ""}`;
      if (fill) {
        // `progress` is optional and may be a 0–1 fraction or a 0–100 percent;
        // with neither, the bar goes indeterminate rather than lying at 0%.
        let pct = null;
        if (typeof job.progress === "number" && isFinite(job.progress)) {
          pct = job.progress <= 1 ? job.progress * 100 : job.progress;
          pct = Math.max(0, Math.min(100, Math.round(pct)));
        }
        fill.style.width = pct === null ? "100%" : `${pct}%`;
        fill.classList.toggle("is-indeterminate", pct === null);
      }
      return;
    }

    clearInterval(_ingestPollTimer);
    _ingestPollTimer = null;
    if (fill) { fill.classList.remove("is-indeterminate"); fill.style.width = "100%"; }
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = "Start Processing"; }

    if (job.state === "done") {
      if (stepEl) stepEl.textContent = "Done — synthetic.duckdb built.";
      showToast("MATSim import complete ✓", "success");
      await loadDatasets(_currentOwnerFilter, _currentOwnerName);
      const updated = _allDatasets.find((d) => String(d.id) === String(dsid));
      if (updated) renderDatasetFiles(updated);
      // A fresh synthetic.duckdb changes what re-zoning is possible.
      _rezoneOptsCache.delete(String(dsid));
      if (updated) loadRezoneOptions(updated);
    } else {
      if (stepEl) stepEl.textContent = `Failed: ${job.detail || "unknown error"}`;
      showToast(`MATSim import failed: ${job.detail || "unknown error"}`);
    }
  };

  _ingestPollTimer = setInterval(tick, 4000);
  tick();
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

  // Bound once here, not in renderDefaultDatasetSelect — that runs on every
  // loadDatasets() and would stack a duplicate listener each time, firing the
  // PUT once per past render.
  const defaultDsSelect = el("defaultDatasetSelect");
  if (defaultDsSelect) {
    defaultDsSelect.addEventListener("change", () => saveDefaultDataset(defaultDsSelect));
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

  const rezoneBtn = el("dsRezoneBtn");
  if (rezoneBtn) {
    rezoneBtn.addEventListener("click", showRezoneConfirm);
  }
  const rezoneConfirmBtn = el("dsRezoneConfirmBtn");
  if (rezoneConfirmBtn) {
    rezoneConfirmBtn.addEventListener("click", startRezone);
  }
  const rezoneCancelBtn = el("dsRezoneCancelBtn");
  if (rezoneCancelBtn) {
    rezoneCancelBtn.addEventListener("click", hideRezoneConfirm);
  }
  // Changing either dropdown invalidates a pending confirmation summary.
  for (const id of ["dsRezoneCanton", "dsRezoneLevel"]) {
    el(id)?.addEventListener("change", hideRezoneConfirm);
  }

  const ingestToggle = el("dsIngestToggle");
  if (ingestToggle) {
    ingestToggle.addEventListener("click", () => toggleIngestSection());
  }
  $$(".ds-ingest-mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchIngestMode(tab.dataset.ingestMode));
  });
  const ingestStartBtn = el("dsIngestStartBtn");
  if (ingestStartBtn) {
    ingestStartBtn.addEventListener("click", startIngest);
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
    const isOwner = g.user_id === _accessDs.owner_id;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(_userLabel(g.user_id))}</td>
      <td><span class="badge ${g.role === "editor" ? "badge-editor" : "badge-viewer"}">${esc(g.role)}</span>${isOwner ? ' <span class="text-muted">(owner)</span>' : ""}</td>
      <td class="text-nowrap">
        ${isOwner ? "" : `<button class="btn btn-danger btn-sm" data-guid="${g.user_id}" data-action="revoke-grant">Remove</button>`}
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
