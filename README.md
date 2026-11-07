# CQA — Conversation Quality Analytics · команда BioC

Freedom Broker CQA Hackathon (DataSci Data Challenge). Оценка работы оператора в чатах и звонках по чек-листу:
баллы, обоснование, ссылки на реплики, N/A, грубые ошибки, апелляции, редактируемые версии чек-листа.

**Демо:** https://cqa-bioc.vercel.app

## Ветки
| Ветка | Что внутри |
|---|---|
| `main` | README и файлы результатов `results/` |
| `frontend` | Сайт: интерфейс (HTML/CSS/JS) + эталонный API на Node, деплой Vercel + Supabase |
| `backend` | Серверная часть на FastAPI (Python) |
| `ML` | Оценщик: факты кодом + LLM-судья Meta Muse Spark 1.3 + проверка ответа + подсчёт итога, промпты, инструменты проверки качества |

## Модель
Meta **Muse Spark 1.3** через Meta API (external_api), около $0.01–0.03 и 20–55 с на одну оценку диалога.

## Результаты (формат JSON 1.0)
- `results/dev/results.json` — DEV: 60 чатов и 5 звонков.
- `results/prod/results.json` — контрольный набор (10 чатов), добавляется до стоп-кода.

## Запуск
Шаги запуска сайта — в README ветки `frontend` (`npm start`, Node 22, без зависимостей).
