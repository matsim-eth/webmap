// authCheck.js — lightweight auth verification for the webmap SPA

const AUTH_BACKEND = "/authentification/backend";
const LOGIN_URL = "/authentification/";

/**
 * Try to verify the current session by calling /me.
 * On 401, attempt a silent token refresh and retry once.
 * Returns the user object on success, or null on failure.
 */
export async function checkAuth() {
  const me = await fetchMe();
  if (me) return me;

  // Access token expired — try refreshing
  const refreshed = await tryRefresh();
  if (!refreshed) return null;

  return fetchMe();
}

async function fetchMe() {
  try {
    const res = await fetch(`${AUTH_BACKEND}/me`, { credentials: "include" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function tryRefresh() {
  try {
    const res = await fetch(`${AUTH_BACKEND}/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Redirect to the authentication page.
 */
export function redirectToLogin() {
  window.location.assign(LOGIN_URL);
}
