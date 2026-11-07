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
`{"conversation_id":"..."}`; этот маршрут пока не реализован.

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
