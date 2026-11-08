# Эталонная разметка (labels)

`dev-gold.json` — черновая ручная разметка 13 диалогов DEV для проверки точности оценщика; её стоит перепроверить ML.
Общая инструкция — в [главном README](https://github.com/Wigunilmi/data-challenge-bioc-team/blob/main/README.md).

```bash
node tools/accuracy.mjs labels/dev-gold.json https://cqa-bioc.vercel.app   # или http://localhost:3000
```

Формат: бинарный критерий — `"yes"`/`"no"`, шкала — число из разрешённых шагов, N/A — `"na"`; для `c08_gross` `"yes"` = нарушение.
```json
[{ "conversation_id": "p1-ru-001",
   "results": { "c01_contact": "yes", "c02_need": "na", "c03_identification": "na", "c04_consultation": 20,
                "c05_empathy": "yes", "c06_management": 10, "c07_closing": "yes", "c08_gross": "no" } }]
```
Частичная разметка допустима: сравниваются только указанные критерии.
