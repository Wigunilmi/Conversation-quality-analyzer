# Reference labels (team ground truth)

**Easiest way:** open a dialog card in the UI, go to the **«Эталон»** tab, pick an answer for each criterion and click «Сохранить эталон и к следующему →». Accuracy appears on «Обзор» right away. The JSON file below is an alternative for the command-line script.

Label 15–20 DEV dialogs by hand with the official checklist (mix RU / KZ / EN, include a call), then:

```bash
npm start                                   # server with LLM key in .env
node tools/accuracy.mjs labels/dev-gold.json
```

Format (`dev-gold.json`):
```json
[{ "conversation_id": "p1-ru-001",
   "results": { "c01_contact": "yes", "c02_need": "na", "c03_identification": "na", "c04_consultation": 20,
                "c05_empathy": "yes", "c06_management": 10, "c07_closing": "yes", "c08_gross": "no" } }]
```
Binary → `"yes"`/`"no"`, scale → a number from the allowed steps, N/A → `"na"`. For c08 `"yes"` means a violation was found.
