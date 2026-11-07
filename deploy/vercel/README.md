# Vercel: switching between the built-in API and the FastAPI backend

The site (`web/`) and the API function (`api/index.mjs`) are deployed from the repo root (`vercel.json`).

- **No `BACKEND_URL`:** the built-in reference API answers (backup "stub", data in Supabase).
- **`BACKEND_URL=https://backend-host`:** every `/api/*` request is proxied to the FastAPI backend.

Switch:
1. `node tools/check-backend.mjs https://backend-host` must print `0 failed`.
2. Vercel → cqa-bioc → Settings → Environment Variables → add `BACKEND_URL` → Redeploy.

Roll back: delete `BACKEND_URL` → Redeploy.
