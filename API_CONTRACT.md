# API contract (frontend ⇄ backend)

The reference implementation is `server.mjs` (Node). The FastAPI backend must return the same shapes, so `web/` works unchanged.
Ready-made Python pieces live in `backend/cqa/`: `scoring.py`, `sanitize.py`, `facts.py`, `evaluator.py`, `audio.py`. Parity tests are in `backend/tests` (479 passing).

## Rules that must not be lost
- **The gross-error mark is stored in the DB.** Each evaluation stores `gross_error` (bool) and `gross_errors` (`[{criterion_id, criterion, explanation, evidence_ids}]`) when it is created, and updates them when an appeal decision changes the gross-error criterion. This is what the «⚠ Грубые ошибки» filter uses (Freedom Broker's requirement).
- **Totals are never stored.** On every read, compute `final_results` = model `results` with decided appeals applied, then call `compute_totals(checklist_version, final_results)`. Also return `original_totals` computed from `results`.
- **Every evaluation stores `checklist_id` + `checklist_version`**, and the checklist is picked **by channel** (`agent chat` → chat set, `voice call` → call set).

## Endpoints

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ok, llm: "MOCK" or model name, votes}` |
| POST | `/api/groups/{gid}/load` | | `{loaded}`: fetch from the organizers' API (server side, CORS) and upsert conversations with `group_id` |
| GET | `/api/groups` | | `["DEV", ...]` |
| GET | `/api/conversations` | `?group=&gross=1` | list rows (below); `gross=1` returns only dialogs with a gross error |
| GET | `/api/conversations/{id}` | | `{conversation, evaluation: View or null, history: [{id, created_at, checklist_id, checklist_version, model, total}]}` |
| GET | `/api/conversations/{id}/audio` | | `{src, page}`: `audio.resolve_audio(audio_url)` (signed mp3, about 1 h) |
| POST | `/api/conversations` | one record, an array of records, or the organizers' API response | `{loaded, ids}`: manual transcript upload. Validate speakers (client/operator/bot/system); missing language is detected from client lines; default group `UPLOAD` |
| POST | `/api/evaluate` | `{conversation_id, checklist_id?}` | View of the new evaluation. Without `checklist_id`, use the set bound to the channel |
| POST | `/api/evaluate-batch` | `{group_id?, only_missing?, concurrency?, checklist_id?}` | `{count, ms, cost_usd, results: [{ok, cid, total}]}` |
| GET | `/api/checklists` | | `[{id, name, channels, active, versions: [{version, created_at, note, checklist}], active_checklist}]` |
| POST | `/api/checklists` | `{name, channels, checklist, note?}` | `{id}`: new set (seeded `chat` and `call` come from `checklists/*.json`) |
| POST | `/api/checklists/{id}/versions` | `{checklist, note}` | `{version}`: validate, append, make active |
| POST | `/api/checklists/{id}/activate` | `{version?}` and/or `{channels?}` | `{ok}`: a channel belongs to one set only |
| GET | `/api/appeals` | `?status=open\|upheld\|changed` | appeals, newest first, each plus `conversation_id` |
| POST | `/api/appeals` | `{evaluation_id, criterion_id, comment, author?}` | appeal; 409 if one is already open for this criterion |
| POST | `/api/appeals/{id}/decide` | `{action: "uphold" or "change", reason, answer? \| score? \| na?}` | `{appeal, evaluation: View}`; 409 if already decided |

### List row (`GET /api/conversations`)
```json
{ "conversation_id": "p1-ru-001", "group_id": "DEV", "channel": "agent chat", "language": "RU", "lines": 12,
  "total": 88.89, "original_total": 100, "critical": ["c08_gross"], "gross_error": true, "gross_reason": "explanation of criterion 08", "checklist_id": "chat", "checklist_version": 2,
  "outdated": false, "appeals_open": 0, "appeals_total": 1,
  "evaluated_at": "ISO", "model": "gpt-4.1-mini", "cost_usd": 0.0012, "ms": 5300, "preview": "first client line…" }
```

### View (an evaluation as returned to the UI)
The stored evaluation is `{id, conversation_id, group_id, checklist_id, checklist_name, checklist_version, created_at, ms}` plus everything `evaluator.evaluate()` returns (`results, problems, facts, model, votes, usage, cost_usd, prompt_version, trace`). The View adds:
`appeals`, `final_results`, `totals`, `original_totals`, `checklist` (that version's JSON).

### Appeal
```json
{ "id": "ap_…", "evaluation_id": "ev_…", "criterion_id": "c01_contact", "comment": "…", "author": "Оператор",
  "status": "open|upheld|changed", "created_at": "ISO", "original": { "criterion result" },
  "decision": { "result": { "answer|score|na" }, "reason": "…", "reviewer": "Проверяющий", "decided_at": "ISO" } }
```
