# backend/ в ветке frontend — Python-порт оценщика (тесты паритета)

Это не рабочий сервер. Здесь лежит Python-порт модулей встроенного Node-API (`cqa/scoring.py`, `sanitize.py`, `facts.py`,
`evaluator.py`, `audio.py`) и тесты, которые сверяют его с JS-эталоном по фикстурам `../test/fixtures/`.
Рабочий FastAPI — в ветке [`backend`](https://github.com/Wigunilmi/data-challenge-bioc-team/tree/backend);
общая инструкция — в [главном README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/main/README.md).

```bash
cd backend
python3 -m pip install pytest
python3 -m pytest -q           # 480 passed (проверено 08.11.2026, Python 3.13)
```

После изменений в `lib/scoring.mjs`, `lib/facts.mjs` или `prompts/` перегенерируйте фикстуры из корня ветки:
`node test/gen-parity.mjs`, `node test/gen-facts.mjs`, `node test/gen-prompts.mjs`.
