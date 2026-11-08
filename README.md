# CQA — Conversation Quality Analytics · команда BioC

Freedom Broker CQA Hackathon (DataSci Data Challenge). Сервис оценивает работу **оператора** в чатах и звонках
(RU / KZ / EN) по настраиваемому чек-листу: ответ и баллы по каждому критерию, объяснение, ссылка на реплику-доказательство,
N/A с причиной, итог 0–100, отдельный флаг грубой ошибки (хранится в БД и ищется фильтром), апелляции с решением
проверяющего и версии чек-листа. Реплики бота и системные события — только контекст.

- **Демо:** https://cqa-bioc.vercel.app
- **API (FastAPI):** https://data-challenge-bioc-team.vercel.app · публичны только `/health` и Swagger `/docs`, все `/api/*` — по сервисному токену
- **Модель:** Meta Muse Spark 1.3 (`muse-spark-1.3`, внешний API), ≈ $0.01–0.03 и 20–55 с на одну оценку диалога

## Ветки и компоненты

Репозиторий: `https://github.com/Wigunilmi/data-challenge-bioc-team`. Ветки не сливаются: каждый компонент живёт в своей.

| Ветка | Что внутри | Инструкция компонента |
|---|---|---|
| [`main`](https://github.com/Wigunilmi/data-challenge-bioc-team/tree/main) | этот README и файлы результатов [`results/`](./results) | — |
| [`frontend`](https://github.com/Wigunilmi/data-challenge-bioc-team/tree/frontend) | интерфейс `web/` (HTML/CSS/JS), Vercel-функция `api/index.mjs` (серверный прокси к FastAPI), запасной Node-API `server.mjs` + `lib/`, инструменты `tools/` | [README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/frontend/README.md), [деплой и переключение на FastAPI](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/frontend/deploy/vercel/README.md), [контракт API](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/frontend/API_CONTRACT.md) |
| [`backend`](https://github.com/Wigunilmi/data-challenge-bioc-team/tree/backend) | FastAPI: `main.py`, маршруты в `backend/`, оценщик `backend/cqa/`, миграции SQLite/Postgres, тесты `backend/tests/` | [README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/backend/README.md), [деплой Vercel + Neon](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/backend/DEPLOY_VERCEL.md) |
| [`ML`](https://github.com/Wigunilmi/data-challenge-bioc-team/tree/ML) | оценщик `ml/`: факты кодом + LLM-судья + проверка ответа + подсчёт итога, промпты, чек-листы, проверка качества | [README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/ML/ml/README.md) |

Как они связаны: браузер ходит только на домен фронта. Функция `api/index.mjs` пересылает `/api/*` в FastAPI и сама
добавляет заголовок `Authorization: Bearer <BACKEND_TOKEN>`, поэтому **токен остаётся на сервере** и CORS для сайта не нужен.
Маршруты, которых в FastAPI пока нет (`/api/health`, `/api/groups`, аудио звонка, `/api/export`, флаг/причина грубой ошибки
в списке и `?gross=1`), фронт собирает из данных самого FastAPI (`lib/bridge.mjs`), ничего не сохраняя у себя.

```
браузер ──► cqa-bioc.vercel.app ──(Bearer, на сервере)──► data-challenge-bioc-team.vercel.app ──► Postgres (Neon)
              web/ + api/index.mjs                         FastAPI main:app                     └─► Meta API (оценка)
```

## Что нужно заранее

| Инструмент | Версия | Для чего |
|---|---|---|
| Git | любая | клонирование веток |
| Node.js | **22.9+** (`node --version`) | фронт; npm-зависимостей нет |
| Python | **3.10+** (Vercel использует 3.14 из `.python-version`) | только для локального FastAPI |

## 1. Основной запуск из чистого клона: фронт + задеплоенный FastAPI

Команды для macOS / Linux (bash). Для Windows PowerShell отличается только способ задать переменные — см. примечание ниже.

```bash
git clone -b frontend https://github.com/Wigunilmi/data-challenge-bioc-team.git cqa-frontend
cd cqa-frontend
export BACKEND_URL=https://data-challenge-bioc-team.vercel.app
read -rs BACKEND_TOKEN && export BACKEND_TOKEN     # вставьте сервисный токен (значение API_AUTH_TOKEN бэкенда), ввод скрыт
npm start
```

Откройте **http://localhost:3000**. В консоли будет строка `CQA on http://localhost:3000`; порт меняется через `PORT=3001 npm start`.

- Токен задаётся только в окружении процесса фронта (или в `.env` фронта, который не коммитится — он в `.gitignore`).
  В браузер, JS-бандл, URL и чат он не попадает.
- PowerShell: `$env:BACKEND_URL = "https://data-challenge-bioc-team.vercel.app"`,
  `$env:BACKEND_TOKEN = Read-Host "Token" -MaskInput` (PowerShell 7+), затем `npm start`.
- Если вместо диалогов видно `unauthorized`, токен неверный; `backend unreachable` — неверный `BACKEND_URL`.

### Готовый сайт на Vercel и его подключение к FastAPI

Проект Vercel фронта собирается из корня ветки `frontend` (`vercel.json`: статика `web/`, функция `api/index.mjs`,
`maxDuration` 300 с). Подключение к задеплоенному FastAPI — две переменные в Vercel → Settings → Environment Variables
(Production) и Redeploy:

| Переменная фронта | Значение |
|---|---|
| `BACKEND_URL` | `https://data-challenge-bioc-team.vercel.app` (без `/api` и без `/` в конце) |
| `BACKEND_TOKEN` | то же значение, что `API_AUTH_TOKEN` у бэкенда; отметить **Sensitive** |

Откат на запасной встроенный API: удалить `BACKEND_URL` и сделать Redeploy (данные встроенного API — в Supabase,
переменные `SUPABASE_URL`, `SUPABASE_KEY`).

Переменные FastAPI на Vercel (значения задаёт владелец проекта; подробности — [DEPLOY_VERCEL.md](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/backend/DEPLOY_VERCEL.md)):

| Переменная | Обязательна | Назначение |
|---|---|---|
| `DATABASE_URL` | да (Vercel) | Postgres (Neon, pooled-строка) |
| `API_AUTH_TOKEN` | да (Vercel) | сервисный токен для `/api/*`, ≥ 32 символов |
| `FRONTEND_ORIGIN` | да (Vercel) | точный origin фронта для CORS, например `https://cqa-bioc.vercel.app` |
| `CQA_API_URL` | для загрузки групп | GET-ссылка организаторов (Student Guide, стр. 3) **без** `group_id` |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | для реальной оценки | без ключа — MOCK; для Meta: `https://api.meta.ai/v1`, `muse-spark-1.3` |
| `LLM_PRICE_IN`, `LLM_PRICE_OUT`, `LLM_CONCURRENCY`, `LLM_VOTES`, `LLM_TEMPERATURE`, `LLM_JSON_MODE` | нет | цена за 1M токенов ($1.25 / $4.25 для Meta), параллелизм батча, голосование, режим JSON |
| `DATABASE_MIGRATION_URL` | нет | direct-строка для миграций |

Миграции Postgres запускаются отдельно (не при старте функции): `python -m backend.migrate_postgres` из корня ветки `backend`.

## 2. Запасной локальный запуск (без облака)

### 2a. Локальный FastAPI (SQLite) + фронт

Терминал 1 — бэкенд:

```bash
git clone -b backend https://github.com/Wigunilmi/data-challenge-bioc-team.git cqa-backend
cd cqa-backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
read -rs CQA_API_URL && export CQA_API_URL       # GET-ссылка организаторов без group_id (нужна для загрузки групп)
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Без `DATABASE_URL` используется SQLite `data/cqa.sqlite3` (миграции применяются при старте). Без `API_AUTH_TOKEN`
локальный API открыт; без `LLM_API_KEY` оценка идёт в MOCK-режиме. PowerShell-вариант команд — в
[README ветки backend](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/backend/README.md).

Терминал 2 — фронт (из клона ветки `frontend`, см. раздел 1):

```bash
cd cqa-frontend
BACKEND_URL=http://127.0.0.1:8000 npm start      # BACKEND_TOKEN не нужен, если у локального бэкенда нет API_AUTH_TOKEN
```

Откройте **http://localhost:3000**. Чистая база пустая: подготовьте её один раз —

```bash
node tools/seed-backend.mjs http://127.0.0.1:8000   # чек-листы чатов и звонков с привязкой к каналам + загрузка группы DEV
```

Скрипт идемпотентен; группу можно указать: `--group DEV`. Для бэкенда с токеном запускайте его через фронт:
`node tools/seed-backend.mjs http://localhost:3000` (токен подставит прокси).

### 2b. Только фронт со встроенным API (без Python)

```bash
cd cqa-frontend
cp .env.example .env      # заполните CQA_API_URL; LLM_* — по желанию (пусто = MOCK)
npm start                 # http://localhost:3000, данные в ./data
```

## 3. Проверка после запуска

Ниже `$API` — адрес, на который вы ходите: `http://localhost:3000` (фронт, токен добавит прокси)
или `http://127.0.0.1:8000` (локальный FastAPI без токена). Для задеплоенного FastAPI напрямую добавляйте
`-H "Authorization: Bearer $BACKEND_TOKEN"` — значение берётся из окружения и не печатается.

| # | Проверка | Как | Ожидаемо |
|---|---|---|---|
| 1 | Живость API | `curl https://data-challenge-bioc-team.vercel.app/health` | `200 {"status":"ok"}` |
| 2 | Swagger | открыть `https://data-challenge-bioc-team.vercel.app/docs` (или `http://127.0.0.1:8000/docs`) → **Authorize** → вставить только токен | все `/api/*` с замком BearerAuth; без токена они отвечают 401 |
| 3 | Связь фронта | `curl $API/api/health` (через фронт) | `{"ok":true,"store":"backend","backend":"ok",…}` |
| 4 | Загрузка группы | UI: поле `group_id` → **⤓ Загрузить набор**; или `curl -X POST $API/api/groups/DEV/load` | `{"loaded":65}` для DEV |
| 5 | Список | UI «Диалоги»; или `curl "$API/api/conversations?group=DEV"` | 65 строк (60 чатов, 5 звонков), фильтры RU/KZ/EN |
| 6 | Карточка | клик по диалогу; или `curl $API/api/conversations/p1-ru-022` | `{conversation, evaluation, history}` |
| 7 | Оценка одного диалога | в карточке **▶ Оценить / ↻ Переоценить**; или `curl -X POST $API/api/evaluate -H 'content-type: application/json' -d '{"conversation_id":"p1-ru-022"}'` | баллы, объяснения, ссылки на реплики; у p1-ru-022 флаг грубой ошибки |
| 8 | Батч | UI: **▶ Оценить** на списке (по одному запросу на диалог, 4 параллельно, прогресс-бар; Shift+клик — переоценить все показанные); API: `curl -X POST $API/api/evaluate-batch -H 'content-type: application/json' -d '{"group_id":"DEV","only_missing":true,"concurrency":4}'` | `{count, ms, cost_usd, results:[{ok,cid,total}]}` |
| 9 | Грубые ошибки | кнопка **⚠ Грубые ошибки** на списке; или `curl "$API/api/conversations?group=DEV&gross=1"` | 4 диалога DEV с причиной |

Для батча на задеплоенном FastAPI используйте кнопку в UI: у функции бэкенда `maxDuration` 60 с, а один запрос
`/api/evaluate-batch` с реальной моделью оценивает всю группу за раз и может не уложиться (см. «Ограничения»).

## 4. Финальная (контрольная) группа — `FBroker`

Контрольный набор: **10 чатов, `group_id = FBroker`**. 08.11.2026 бэкендер загрузил его в FastAPI (база Neon).
Оценки и выгрузка делаются там, где лежат эти данные: через фронт, подключённый к FastAPI (`BACKEND_URL` + `BACKEND_TOKEN`,
раздел 1). Если сайт работает на запасном API (`/api/health` → `"store":"supabase"`), набор нужно загрузить и туда (шаг 2).

1. **Проверить связь:** шаги 1 и 3 из таблицы выше; `$API/api/health` → `"store":"backend"`.
2. **Убедиться, что набор на месте:** UI → фильтр «Все наборы» → `FBroker` → 10 строк.
   Если группы нет — вписать `FBroker` в поле `group_id` → **⤓ Загрузить набор** (ожидаемо `Загружено диалогов: 10`);
   или `curl -X POST $API/api/groups/FBroker/load`. Исходные `conversation_id` берутся из API организаторов.
3. **Оценить:** при выбранной группе `FBroker` → **▶ Оценить**. Оценка идёт по чек-листу, привязанному к каналу
   (чаты → чек-лист чатов). Дождаться `Готово: 10 диалогов`.
4. **Проверить сохранённые оценки:** обновить страницу — у всех 10 строк есть итог; открыть 1–2 карточки (объяснения,
   ссылки на реплики, N/A с причинами); проверить фильтр «⚠ Грубые ошибки». Через API:
   `curl "$API/api/conversations?group=FBroker"` — 10 строк, у каждой `total` не `null` и есть `evaluated_at`.
   Если у части диалогов оценки нет — снова **▶ Оценить** (оцениваются только недостающие).
5. **Выгрузить результаты** (формат JSON 1.0 из приложения к гайду) из клона ветки `frontend`, указав адрес фронта,
   подключённого к FastAPI (сайт или `http://localhost:3000` из раздела 1):
   ```bash
   node tools/export-results.mjs <адрес фронта> --group FBroker --out results/prod/results.json --expected 10
   ```
   Скрипт проверяет формат и ровно 10 записей и завершится ошибкой при любом несоответствии. То же — кнопка
   **⤓ results.json** в UI при выбранной группе `FBroker`.
6. **Закоммитить в `main`:** положить файл в `results/prod/results.json` этой ветки, `git add results/prod/results.json`,
   commit и **push до стоп-кода** (локального коммита без push недостаточно).

## Результаты (`results/`)

- [`results/dev/results.json`](./results/dev/results.json) — DEV: 60 чатов и 5 звонков, 65 записей.
- `results/prod/results.json` — контрольный набор `FBroker`, 10 чатов; добавляется по шагам раздела 4.

Обновить DEV-файл: `node tools/export-results.mjs https://cqa-bioc.vercel.app --group DEV --out results/dev/results.json --expected 65`.

## Ограничения и что не подтверждено

Проверено 08.11.2026 на чистых клонах (Linux, Node 22.23, Python 3.13): бэкенд — `pip install -r requirements.txt`,
`pytest` (568 passed, 3 skipped — Postgres-интеграция без `TEST_DATABASE_URL`), запуск Uvicorn, `/health`, `/docs`, OpenAPI со схемой
BearerAuth; фронт с `BACKEND_URL` на этот локальный бэкенд — загрузка DEV, список, карточка, оценка, батч (65/65, MOCK),
фильтр грубых ошибок (4), выгрузка results.json с проверкой формата; `npm test` фронта (11 passed). У задеплоенного API
проверены `/health` (200), `/docs` и `/openapi.json` (200) и ответ 401 на `/api/*` без токена.

Не подтверждено / известные ограничения:

- Работа фронта с **задеплоенным** FastAPI под токеном не проверялась: у автора этого README нет токена. На момент проверки
  сайт https://cqa-bioc.vercel.app отвечал из запасного встроенного API (`/api/health` → `"store":"supabase"`), то есть
  `BACKEND_URL` в его Vercel ещё не задан.
- Batch на задеплоенном FastAPI с реальной моделью не запускался; при `maxDuration: 60` длинный батч может прерваться по
  таймауту — используйте кнопку «Оценить» в UI (отдельный запрос на диалог).
- Ручная загрузка диалога (`POST /api/conversations`, кнопка «⤒ Загрузить диалог») есть только во встроенном API;
  при работе через FastAPI прокси отвечает 501 с объяснением.
- Миграции Neon (`python -m backend.migrate_postgres`) и PowerShell-варианты команд не выполнялись автором этого README.
