# Передача API фронтендеру

Проверено 07.11.2026 на чистом клоне коммита `f0d9953`, Python 3.14.6,
в новом venv: **556 passed**, одно предупреждение Starlette. Настоящий Uvicorn
запустился, сквозная HTTP-проверка прошла в MOCK-режиме. Рабочая БД DEV не менялась.

## Адреса и CORS

- После деплоя передать **публичный HTTPS origin бэкенда**, например
  `https://api.example.com` (пример, фактического адреса деплоя пока нет).
  Маршруты уже включают `/api`: полный URL списка —
  `https://api.example.com/api/conversations`. Не добавлять `/api` дважды.
- Исходный фронт Заира делает относительные запросы `/api/...`. Предпочтительный
  вариант для него — proxy/rewrite на домене фронта:
  `/api/:path*` → `https://<backend-host>/api/:path*`. При таком режиме CORS между
  браузером и API не требуется: браузер обращается к своему origin.
- При прямом вызове API разрешить **origin фронта**, например
  `https://frontend.example.com`, без пути и завершающего `/`. Для локальной
  разработки отдельно добавить точный origin, например `http://localhost:5173`.
  Схема, хост и порт учитываются; домен бэкенда не заменяет origin фронта.
- **Сейчас CORSMiddleware отсутствует**: preflight проверен и вернул 405 без
  `Access-Control-Allow-Origin`. До прямого браузерного доступа добавить middleware
  с точными `allow_origins`, методами `GET`/`POST` и заголовками
  `Content-Type`/`Authorization`. Переменной окружения для CORS в коде пока нет.
  [Документация FastAPI](https://fastapi.tiangolo.com/tutorial/cors/).
- На деплое `CQA_DATABASE_PATH` должен указывать на сохраняемый диск. Ключ модели
  и `CQA_API_URL` задаются только на сервере, браузеру не передаются.

## Короткий сценарий приёмки

Подготовка: запуск по [README](./README.md), отдельная тестовая БД,
`python -m backend.database --seed-demo`; без `LLM_API_KEY`, то есть MOCK.
Тестовая группа — **SYNTHETIC**, ID — `synthetic-chat-001`. Не использовать DEV
для этого сценария и не переносить секреты в запросы браузера.

- [ ] `GET /api/conversations?group=SYNTHETIC` → 200, диалог есть в списке.
  `GET /api/conversations/synthetic-chat-001` → 200; без оценки `evaluation:null`.
  Неизвестный ID → 404 `{"error":"not found"}`.
- [ ] Однократно `POST /api/evaluate` с `{"conversation_id":"synthetic-chat-001"}`
  в MOCK-режиме. В карточке есть `results`, `totals`, `original_totals` и версия.
- [ ] `POST /api/appeals` с `{evaluation_id,criterion_id,comment}`; затем
  `POST /api/appeals/{id}/decide` с `{action:"change",reason,answer:"yes"|"no"}`
  для бинарного критерия. Проверить `GET /api/appeals`, счётчики списка, исходный
  и финальный итоги карточки. Для другого критерия проверить `uphold`: причина
  сохранена, итог не меняется. Повторное решение → 409.
- [ ] `GET /api/checklists`; изменить копию полного `active_checklist` и отправить
  `POST /api/checklists/chat/versions` с `{checklist,note}`. Новая версия
  **активируется сразу**. Проверить старый итог карточки и `outdated:true` в списке.
- [ ] Проверить `/api/checklists/chat/activate` сначала с `{version:1}`, затем
  `{version:2}`. Карточка по-прежнему относится к версии своей оценки;
  `outdated` находится только в списке.
- [ ] `POST /api/evaluate-batch` с
  `{"group_id":"SYNTHETIC","only_missing":true,"concurrency":2}` → 200,
  после смены версии `count:1`; повтор → `count:0`. Проверить `ok`, `cid`,
  `total` в результатах. Тесты отдельно покрывают 14 диалогов и частичный сбой.

## Сверка контракта

Реализованы все 12 маршрутов этих сценариев: загрузка группы, список/карточка,
одиночная/пакетная оценка, четыре маршрута чек-листов и три маршрута апелляций.

Из 19 маршрутов контракта пока отсутствуют:

- `GET /api/health` — вместо него доступен `GET /health` → `{"status":"ok"}`;
- `GET /api/groups`;
- `GET /api/conversations/{id}/audio`;
- `GET /api/labels` и `POST /api/labels`;
- `GET /api/stats` и `GET /api/export`.

Полная работа исходного фронта, использующего эти маршруты, пока не подтверждена.
Отдельно известны различия с Node-эталоном: `only_missing` учитывает любую
завершённую оценку выбранной версии в истории (по согласованному требованию),
а у старых версий без записанного времени создания `created_at:null`.
