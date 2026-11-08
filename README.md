# CQA · frontend (ветка `frontend`)

Интерфейс и серверный прокси. Общая инструкция — запуск, подключение к FastAPI, проверка, финальная группа —
в [главном README (ветка main)](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/main/README.md).

## Состав
| Путь | Что |
|---|---|
| `web/` | UI без фреймворка: `screens/list.js` (диалоги, загрузка набора/диалогов, батч), `card.js` (оценка, доказательства, апелляции), `checklists.js` (редактор и версии), `appeals.js` (проверяющий); `lib/api.js`, `lib/prefs.js` (тема, режимы «Слабое зрение» / «Дальтонизм») |
| `api/index.mjs` | Vercel-функция: при `BACKEND_URL` проксирует `/api/*` в FastAPI с `Authorization: Bearer $BACKEND_TOKEN`, иначе отвечает встроенный API |
| `lib/bridge.mjs` | маршруты, которых нет в FastAPI: `/api/health`, `/api/groups`, аудио, `/api/export`, флаг грубой ошибки и `?gross=1` |
| `server.mjs`, `lib/app.mjs`, `lib/store.mjs` | локальный сервер и запасной встроенный API (файлы `./data` или Supabase) |
| `lib/evaluator.mjs`, `lib/facts.mjs`, `lib/scoring.mjs`, `lib/results.mjs`, `prompts/`, `checklists/` | оценщик встроенного API, подсчёт итога, формат results.json |
| `tools/` | `seed-backend.mjs`, `check-backend.mjs`, `export-results.mjs`, `review.mjs`, `accuracy.mjs` |
| `backend/` | Python-порт оценщика для тестов паритета ([README](./backend/README.md)); рабочий FastAPI — ветка `backend` |
| `API_CONTRACT.md` | контракт API фронт ⇄ бэк |

## Команды (из корня ветки, Node 22.9+, без npm-зависимостей)
```bash
npm start                                    # http://localhost:3000; читает .env, если он есть
BACKEND_URL=http://127.0.0.1:8000 npm start  # фронт поверх локального FastAPI
npm test                                     # JS-тесты подсчёта итога
node tools/seed-backend.mjs <api>            # чек-листы чатов/звонков + загрузка DEV в чистый бэкенд
node tools/check-backend.mjs <api>           # 12 шагов контракта; переключать только при «0 failed»
node tools/export-results.mjs <site> --group DEV --out results/dev/results.json --expected 65
```

## Переменные окружения (значения не коммитятся; `.env` в `.gitignore`)
| Переменная | Назначение |
|---|---|
| `BACKEND_URL`, `BACKEND_TOKEN` | адрес FastAPI и его сервисный токен (`API_AUTH_TOKEN`); токен используется только на сервере |
| `PORT` | порт локального сервера, по умолчанию 3000 |
| `CQA_API_URL` | GET-ссылка организаторов без `group_id` — для встроенного API |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_PRICE_IN`, `LLM_PRICE_OUT`, `LLM_CONCURRENCY`, `LLM_VOTES`, `LLM_REASONING_EFFORT` | модель встроенного API; без ключа — MOCK |
| `SUPABASE_URL`, `SUPABASE_KEY` | хранилище встроенного API на Vercel (иначе файлы `./data`) |

Шаблон — [`.env.example`](./.env.example). Деплой и переключение встроенный API ⇄ FastAPI — [deploy/vercel/README.md](./deploy/vercel/README.md).

## Модель и стоимость
Meta Muse Spark 1.3 (`muse-spark-1.3`, `reasoning_effort: low` во встроенном API): один вызов модели + максимум один
повтор при ошибке формата, ≈ $0.01–0.03 и 20–55 с на диалог ($1.25 / $4.25 за 1M токенов). Факты и итог считаются кодом.
