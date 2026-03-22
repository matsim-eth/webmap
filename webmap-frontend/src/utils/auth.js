const AUTH_API = "/authentification/backend";

/** Redirect to the login page, preserving the current path as ?next= */
export function redirectToLogin() {
  const next = window.location.pathname;
  window.location.assign(`/authentification/?next=${encodeURIComponent(next)}`);
}

/** Try to refresh the access token via the auth backend. Returns true on success. */
let refreshPromise = null;
export function tryRefresh() {
  if (!refreshPromise) {
    refreshPromise = fetch(AUTH_API + "/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/** Check if the user is currently authenticated (tries refresh if needed). */
export async function checkAuth() {
  let res = await fetch(AUTH_API + "/me", { credentials: "include" });

  if (res.status === 401) {
    const ok = await tryRefresh();
    if (ok) {
      res = await fetch(AUTH_API + "/me", { credentials: "include" });
    }
  }

  return res.ok;
}

/**
 * Handle a 401 from a backend request: attempt token refresh.
 * Returns true if refresh succeeded (caller should retry the request).
 * Redirects to login and returns false if refresh fails.
 */
export async function handle401() {
  const ok = await tryRefresh();
  if (!ok) {
    redirectToLogin();
    return false;
  }
  return true;
}

/** Check if the current user has admin or dev privileges. */
export async function checkIsAdmin() {
  try {
    const res = await fetch(AUTH_API + "/me", { credentials: "include" });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data.admin || data.dev);
  } catch {
    return false;
  }
}
