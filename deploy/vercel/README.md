# Vercel: сайт фронта и переключение встроенный API ⇄ FastAPI

Проект Vercel собирается из корня ветки `frontend` по `vercel.json`: статика `web/`, функция `api/index.mjs`
(`maxDuration` 300 с, регион `fra1`), rewrite `/api/*` → `/api/index`. Общая инструкция — в
[главном README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/main/README.md).

| Режим | Переменные проекта фронта |
|---|---|
| FastAPI (основной) | `BACKEND_URL` = адрес FastAPI без `/api`; `BACKEND_TOKEN` = его `API_AUTH_TOKEN` (Sensitive) |
| Встроенный API (запасной) | без `BACKEND_URL`; `SUPABASE_URL`, `SUPABASE_KEY`, `CQA_API_URL`, `LLM_*` |

Токен подставляется на сервере в `Authorization: Bearer …` и в браузер не попадает, поэтому CORS бэкенда для этого сайта не нужен.

## Включить FastAPI
1. Чистый бэкенд подготовить один раз: `node tools/seed-backend.mjs <api>` — чек-листы чатов и звонков с привязкой к каналам и загрузка DEV
   (идемпотентно). Для бэкенда с токеном запускайте через фронт, где задан `BACKEND_TOKEN`, например `http://localhost:3000`.
2. Проверить контракт через фронт: `BACKEND_URL=<api> BACKEND_TOKEN=… npm start`, затем `node tools/check-backend.mjs http://localhost:3000`.
   Переключать только при `0 failed`; известный пропуск — ручная загрузка диалога (в FastAPI нет `POST /api/conversations`, прокси отвечает 501).
3. Vercel → Settings → Environment Variables → `BACKEND_URL`, `BACKEND_TOKEN` → **Redeploy**.
4. Проверить: `https://<сайт>/api/health` → `"store":"backend","backend":"ok"`.

**Откат:** удалить `BACKEND_URL` → Redeploy.

`lib/bridge.mjs` отвечает на маршруты, которых в FastAPI пока нет (`/api/health`, `/api/groups`, аудио, `/api/export`,
флаг/причина грубой ошибки в списке и `?gross=1`), из данных самого FastAPI; остальные запросы проксируются без изменений.
