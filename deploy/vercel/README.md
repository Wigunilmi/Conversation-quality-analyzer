# Vercel: switching between the built-in API and the FastAPI backend

The site (`web/`) and the API function (`api/index.mjs`) are deployed from the repo root (`vercel.json`).

- **No `BACKEND_URL`:** the built-in reference API answers (backup "stub", data in Supabase).
- **`BACKEND_URL=https://backend-host`:** every `/api/*` request is proxied to the FastAPI backend.

Switch:
1. `node tools/check-backend.mjs https://backend-host` must print `0 failed`.
2. Vercel → cqa-bioc → Settings → Environment Variables → add `BACKEND_URL` → Redeploy.

Roll back: delete `BACKEND_URL` → Redeploy.


## Connecting the team FastAPI backend (branch `backend`)
1. Deploy the backend anywhere with HTTPS and a persistent disk (`CQA_DATABASE_PATH` on that disk),
   with `CQA_API_URL`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_PRICE_IN`, `LLM_PRICE_OUT` in its environment.
2. `node tools/seed-backend.mjs https://<backend>` — creates the chat / call checklist sets and loads DEV (idempotent).
3. `node tools/check-backend.mjs https://<backend>` through the bridge, e.g. locally:
   `BACKEND_URL=https://<backend> npm start` then `node tools/check-backend.mjs http://localhost:3000`.
4. Vercel → Environment Variables → `BACKEND_URL=https://<backend>` and `BACKEND_TOKEN=<the backend API_AUTH_TOKEN>` (Sensitive) → Redeploy. Remove `BACKEND_URL` to fall back to the built-in API.
   The token is added server-side as `Authorization: Bearer …`; the browser never sees it, so the backend needs no CORS for this site.

`lib/bridge.mjs` answers the routes the backend does not have yet (`/api/health`, `/api/groups`, audio,
`/api/export`, gross-error flag/reason and `?gross=1`) from the backend's own data; everything else is proxied.
CORS is not needed: the browser only talks to the Vercel domain.
