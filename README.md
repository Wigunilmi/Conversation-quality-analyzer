# data-challenge-bioc-team

## Минимальный бэкенд FastAPI

Требуется Python 3.10 или новее. Выполняйте команды из папки проекта в Windows PowerShell.

Установка зависимостей в виртуальное окружение:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Запуск сервера:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Проверка в другом окне PowerShell:

```powershell
$response = Invoke-WebRequest -Uri "http://127.0.0.1:8000/health" -UseBasicParsing
$response.StatusCode
$response.Content
```

Ожидаемый результат: код `200` и тело `{"status":"ok"}`.
Для остановки сервера нажмите `Ctrl+C` в окне, где он запущен.

## Материалы интегратора

Исходные материалы Заира находятся в [архив интегратора (заира)](./архив%20интегратора%20(заира)/).
Контракт API: [API_CONTRACT.md](./архив%20интегратора%20(заира)/API_CONTRACT.md).
Работайте с исходными материалами из этой папки; временные копии не являются частью приложения.

Сейчас в папке интегратора лежат контракт, сообщения команде, Node-сервер и архив
`cqa-scaffold.tar.gz`. Из него выборочно перенесены Python-модули в `backend/cqa`,
тесты в `backend/tests`, настройки `backend/pyproject.toml`, чек-листы в `checklists`,
промпты в `prompts` и тестовые фикстуры в `test/fixtures`. Структура путей сохранена;
исходные материалы интегратора не изменены. Полная копия архива не создавалась.
В материалах нет готовой точки входа FastAPI: для текущего приложения используется
`main:app`. По контракту оценка одного диалога — `POST /api/evaluate` с телом
`{"conversation_id":"..."}`; маршрут реализован для одного диалога с сохранением в SQLite.

## База данных и оценка одного диалога

Миграция `backend/migrations/001_evaluations.sql` создаёт диалоги, версии чек-листов,
привязку активной версии к каналу, оценки и результаты критериев. База по умолчанию —
`data/cqa.sqlite3` (локальная, исключена из Git). Для другого пути задайте
`$env:CQA_DATABASE_PATH = "C:\path\to\cqa.sqlite3"` перед миграцией и запуском сервера.

Из корня проекта примените миграцию и явно добавьте один синтетический чат
`synthetic-chat-001` и одну версию чек-листа `chat:1`:

```powershell
.\.venv\Scripts\python.exe -m backend.database --seed-demo
```

Команда без `--seed-demo` применяет только миграции. Миграции также применяются при
старте FastAPI. Повторный запуск команды не перезаписывает существующие данные.
Синтетический диалог не использует датасет организаторов.

Для локальной проверки в MOCK-режиме перед запуском сервера уберите ключ только
из окружения текущего окна PowerShell:

```powershell
Remove-Item Env:LLM_API_KEY -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

В другом окне:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/evaluate" `
    -ContentType "application/json" -Body '{"conversation_id":"synthetic-chat-001"}'
```

Успешный ответ — `200` и `View` по контракту. Активный чек-лист выбирается по каналу
до вызова модели; оценка и все результаты сохраняются одной транзакцией вместе с
`checklist_id` и `checklist_version`. Итоги вычисляются при формировании ответа и
в БД не сохраняются. Для неизвестного ID ответ — `404` и
`{"error":"conversation <id> not loaded"}`. Хранилище и API апелляций на этом шаге
не добавлены; у новой оценки `appeals` пуст, `final_results` совпадают с `results`.

API-тесты в `backend/tests/test_api_evaluate.py` используют временные БД и
подменяют вызов модели. Проверяют ответ и сохранение критериев, откат всей
транзакции при ошибке, выбор чек-листа по каналу и фиксацию версии до вызова модели.
Они запускаются той же командой `python -m pytest -q` из `backend` (см. ниже).
После добавления маршрута: **489 passed in 5.93s**, включая 480 прежних тестов и
9 новых. Отдельный тест запускает настоящий `evaluate` с подменой транспорта
модели; настоящий ключ и внешние сервисы не используются. Starlette выдаёт одно
предупреждение об устаревании `httpx` в TestClient; ошибок тестов нет.

## Чек-листы и версии

В текущем `API_CONTRACT.md` используются маршруты во множественном числе:

- `GET /api/checklists` — наборы с `id`, `name`, `channels`, `active`, `versions`
  и `active_checklist`.
- `POST /api/checklists` с `{name, channels, checklist, note?}` — новый набор,
  ответ `{id}`. Указанные каналы переходят новому набору; каждый канал принадлежит
  только одному набору.
- `POST /api/checklists/{id}/versions` с `{checklist, note}` — проверка критериев,
  новая версия и её активация для всех каналов набора, ответ `{version}`.
- `POST /api/checklists/{id}/activate` с `{version?}` и/или `{channels?}` — выбор
  сохранённой версии и/или привязка каналов, ответ `{ok:true}`.

Маршруты `/api/checklist` в единственном числе в контракте отсутствуют и не добавлены.
Изменение критерия передаётся как полный JSON чек-листа в маршрут `/versions`.
Старая версия и оценки не перезаписываются. Номер следующей версии и переключение
активности сохраняются одной транзакцией; параллельные изменения получают разные номера.

Миграция `backend/migrations/002_checklist_metadata.sql` сохраняет существующую
таблицу `checklist_versions` и добавляет метаданные версий и активного набора.
Она применяется автоматически при старте либо командой
`.\.venv\Scripts\python.exe -m backend.database`. Для старых версий без записанного
времени создания `created_at` возвращается как `null`; у новых версий — UTC ISO timestamp.

Новая версия активируется сразу при создании через `/versions`, как указано в
контракте (`validate, append, make active`). Отдельный `/activate` нужен для выбора
существующей версии и/или изменения привязки каналов.
При смене активной версии прежний итог в карточке и истории остаётся рассчитанным
по версии оценки. Поле `outdated` есть только в строке списка: `true`, если
сохранённая оценка относится к другому набору или версии. Карточка содержит ровно
`conversation`, `evaluation` и `history`, без дополнительного поля `outdated`.
Это чтение не обращается к модели.

## Список и карточка диалога

`GET /api/conversations` возвращает строки списка по контракту; `?group=DEV`
оставляет только диалоги указанной группы. У диалога без оценки `total`,
`original_total`, модель и версия чек-листа равны `null`.

`GET /api/conversations/{id}` возвращает `conversation`, последнюю сохранённую
оценку `evaluation` (или `null`) и `history` от старых оценок к новым.
Неизвестный ID: `404` с `{"error":"not found"}`.

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/api/conversations?group=DEV"
Invoke-RestMethod "http://127.0.0.1:8000/api/conversations/p1-en-001"
```

GET не вызывает модель и не создаёт оценки. Итоги списка, карточки и каждой записи
истории пересчитываются из сохранённых критериев по `checklist_id` и
`checklist_version` соответствующей оценки. Активная версия используется только
для признака `outdated`; она не заменяет исторический чек-лист при подсчёте.
Хранилище апелляций пока не добавлено: `appeals` пуст, `final_results` совпадают с
`results`, счётчики апелляций равны нулю.

## Python-тесты интегратора и PowerShell

Тесты запускаются из `backend`. Вместе с ним нужны соседние папки
`test/fixtures`, `checklists` и `prompts`, уже перенесённые из архива.
Следующие команды выполняйте из корня проекта:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:PYTHONUTF8 = "1"
$projectPython = (Resolve-Path .\.venv\Scripts\python.exe).Path
Push-Location .\backend
try {
    & $projectPython -m pytest -q
} finally {
    Pop-Location
}
```

`PYTHONUTF8=1` включает чтение UTF-8 вместо системной CP1251 в Windows.
Активация виртуального окружения и изменение ExecutionPolicy не требуются.
При проверке исходного scaffold 7 ноября 2026 года: **480 passed in 2.15s**.
Проверка выполнялась во временной копии с Python 3.14.6; исходный код тестов не менялся.
После выборочного переноса в рабочий проект: **480 passed in 2.62s**
с `PYTHONUTF8=1`, импорт `evaluate` успешен, `GET /health` вернул `200` и `{"status":"ok"}`.

Проверка импорта из корня проекта в том же окружении, где работает FastAPI:

```powershell
.\.venv\Scripts\python.exe -c "from fastapi import FastAPI; from backend.cqa.evaluator import evaluate; assert callable(evaluate); print('evaluate import OK')"
```

Для этих проверок используются только локальные тестовые фикстуры и MOCK-режим;
датасет организаторов и ключ модели не нужны. Существующий `GET /health` сохранён.

`.venv` и `.tmp` используются только локально и исключены из Git.
