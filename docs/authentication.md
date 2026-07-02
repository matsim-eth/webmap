# Authentication & Authorization

How users, tokens, and dataset permissions work across the stack.

## Components

| Piece | Where | Role |
|---|---|---|
| **auth backend** | `authentification-backend/` (:5032) | Registers users, verifies passwords, issues/rotates JWTs, admin API |
| **auth frontend** | `authentification-frontend/` (:5022) | Login page + admin panel (`/authentification/admin/`) |
| **AuthAPI** | shared Python package (installed from git in each backend's `requirements.txt`) | JWT creation/validation, password hashing, `RequireUser`/`RequireAdminUser` FastAPI dependencies, user/refresh-token SQLAlchemy models |
| **auth database** | Postgres | `users`, `refresh_tokens` tables |
| **dataset backend** | `dataset-backend/` (:5033) | *Authorization* for datasets (who may read which dataset) |
| **webmap backend** | `webmap-backend/` (:5031) | Validates the JWT on every data request (signature only, no DB) |

All backends share the same `JWT_SECRET` (root `.env`) — the auth service signs,
everyone else verifies locally. **Changing the secret invalidates all sessions
and must happen in all services at once.**

## Token model

* **Access token** — short-lived JWT (`ACCESS_TOKEN_MINUTES`, default 15 min in
  compose). Claims: `sub` (user id as string), `admin` (bool),
  `typ: "access"`, `exp`.
* **Refresh token** — long-lived JWT (`REFRESH_TOKEN_DAYS`) with a `jti`.
  Stored **hashed** in the auth DB; on every refresh the old token is revoked
  and replaced (`replaced_by_jti`) → rotation, a stolen refresh token dies on
  first reuse.
* Both are set as **cookies** (`access_token`, `refresh_token`) by the auth
  backend. Cookie flags come from `COOKIE_SECURE` (default on in prod) and
  `COOKIE_SAMESITE` (default `lax`). Because every service is behind the same
  proxy origin, cookies flow to all backends automatically — no CORS needed.

## Endpoints (auth backend, public path `/authentification/backend/…`)

| Endpoint | Purpose |
|---|---|
| `POST /register` | Create account (also triggers per-user storage init in the dataset service) |
| `POST /login` | Email **or** username (or a single `identifier` field); verifies password, sets both cookies |
| `POST /refresh` | Accepts the refresh token from cookie, `X-Refresh-Token` header, or body; rotates it, sets new cookies |
| `GET /me` | Current user from the access token |
| `GET/PUT/DELETE /admin/users…` | Admin user management (requires admin role) |
| `GET /health` | Liveness |

**Dev mode:** with `DEV_MODE=1` a dev account (`DEV_EMAIL`/`DEV_PASSWORD`,
default `dev@local`/`dev`) is seeded and allowed to log in; with `DEV_MODE=0`
dev accounts are blocked at login (the flag lives on the user row).

## How each service checks auth

* **Auth & dataset backends** use the `AuthAPI` dependencies:

  ```python
  from AuthAPI import RequireUser, RequireAdminUser

  @router.get("/datasets")
  async def list_datasets(user=Depends(RequireUser())): ...      # any valid user

  @router.get("/admin/datasets")
  async def all_datasets(user=Depends(RequireAdminUser())): ...  # admin only
  ```

* **Webmap backend** uses a blanket `AuthMiddleware` (`main.py`): every request
  except `/health` and the docs must carry a *valid* `access_token` cookie —
  signature and expiry are checked locally with `decode_token`, no DB hit.
  `LOCAL_RUN=1` disables this entirely (local development/testing).

* **Frontends** never store tokens in JS — cookies only. On a 401 both
  frontends call `handle401()` → one `POST /refresh` round-trip → retry the
  original request → redirect to the login page if refresh also fails.

## Registration gates (optional)

Two independent, env-switchable gates control what happens after `/register`
(both **off by default** — registration then behaves exactly as before):

| `.env` flag | Effect |
|---|---|
| `REQUIRE_EMAIL_VERIFICATION=1` | New accounts get `email_verified=false` and a mailed verification link (`GET /verify-email?token=…`, valid `VERIFY_TOKEN_HOURS`, default 48 h). Login is blocked with **403 "email not verified"** until clicked. `POST /resend-verification` re-sends (never leaks whether an address exists). Without SMTP config (`SMTP_HOST` etc.) the link is **written to the auth-backend log** instead — the flow stays testable locally. |
| `REQUIRE_ADMIN_APPROVAL=1` | New accounts get `approved=false`. Login is blocked with **403 "account pending admin approval"** until an admin approves them — admin panel → Users (pending accounts float to the top with a banner and an **Approve** button), or `POST /admin/users/{id}/approve`. |

Implementation notes:

* The flags live on extra `users` columns (`email_verified`, `approved`,
  `verify_token`, `verify_token_expires`) added via idempotent
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at startup, defaulting to `TRUE` —
  **existing accounts keep working** when a gate is switched on later.
* `is_active` keeps its old meaning (admin soft-delete) and is independent.
* Gates are enforced at **login**, and remain enforced for accounts created
  while a gate was active even if the flag is later turned off.
* Seeded accounts (admin, dev) are always verified + approved.
* The login page distinguishes 403 (gated) from 401 (bad credentials) and
  offers a one-click "Resend verification email" on unverified accounts.
* Admins can also override per user: `PATCH /admin/users/{id}` with
  `{"email_verified": true}` ("Mark verified") or `{"approved": true}`.

## Dataset authorization

Data-level permissions live in the **dataset service**, not in the webmap
backend. The rule set (`dependencies.require_dataset_access`):

1. unknown id → 404
2. `status == inactive` → 403
3. `is_public` → allowed for every authenticated user
4. otherwise only the **owner** → 403 for everyone else

**Sharing (grants).** A private dataset can be shared with individual users
via `dataset_grants` (`viewer` = read/map/dashboard, `editor` = additionally
upload files). Managed by the owner or an admin: admin panel → Datasets →
**Access**, or `GET/POST /datasets/{id}/grants` +
`DELETE /datasets/{id}/grants/{user_id}`. Shared datasets appear in the
recipient's dataset list automatically; admins implicitly have full access to
every dataset.

The webmap backend enforces this indirectly: every `/data/{dataset_id}/…`
request first calls `GET /datasets/{id}/resolve` on the dataset service **with
the user's cookie**. No access → resolve fails → the webmap backend returns
`{"error": "Dataset resolution failed…"}` and never touches the files.
(Resolve results are cached per *(dataset, user)* in the worker process.)

`/internal/*` endpoints (user-storage lifecycle) are service-to-service calls
from the auth backend and are not linked from any frontend.

## Request walk-through (authenticated data fetch)

```
Browser (cookie: access_token)
  → GET /backend/data/7/age.json
    proxy strips /backend → webmap_backend
      1. AuthMiddleware: decode_token(cookie)                    [401 if invalid]
      2. GET dataset_backend:5033/datasets/7/resolve  (same cookie)
           RequireUser() → require_dataset_access(7)             [403/404 → error]
      3. provider runs against /data/datasets/public/7/*.duckdb
  ← JSON
```

## Operational notes

* **Seeded accounts:** `ADMIN_EMAIL`/`ADMIN_PASSWORD` (admin) and the dev
  account are created at auth-backend startup from `.env`.
* **Logout** = deleting the cookies client-side; refresh-token rows can be
  revoked server-side via the admin API.
* **Token lifetime tuning:** `.env` `ACCESS_TOKEN_MINUTES` /
  `REFRESH_TOKEN_DAYS`. Long access lifetimes (e.g. 1440) are convenient on
  dev boxes but weaken revocation in prod — access tokens are not checked
  against the DB.
* Adding an **authenticated route to the webmap backend**: see
  [webmap-backend.md → Adding an authenticated route](webmap-backend.md#adding-an-authenticated-route).
