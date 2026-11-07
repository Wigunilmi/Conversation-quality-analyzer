# CQA: Conversation Quality Analytics · team BioC

A prototype for Freedom Broker that scores operator conversations (chats and calls in RU / KZ / EN) against configurable checklists. Every score comes with an explanation and a link to the exact message (or the moment in the call recording), can be appealed, and is reviewed by a human.

## What it does (strictly the Student Guide and the checklist)
- **Checklist setup.** Add and edit criteria: wording, weight, answer type (Yes/No or scale with steps), whether N/A is allowed and its rule, sections, the gross-error flag. Every save becomes a new version that applies to new evaluations. Chats and calls have their own checklists (the call one adapts the official checklist to speech, per Freedom Broker's clarification).
- **Evaluation.** Load a set by `group_id` (DEV or the control set) or upload a transcript by hand, pick a checklist (or let it be chosen by channel), and run the evaluation. RU / KZ / EN. Bot and system lines are context only.
- **Result.** For each criterion the card shows the answer, points, weight, explanation and evidence message; for a missed action, the part of the dialog that was checked; for N/A, the reason. It also shows the total, section totals and the gross-error flag. Scores are computed by code: scale steps weighted, N/A weight redistributed, rounded to 2 decimals, no total when every weighted criterion is N/A.
- **Card.** Clicking the evidence scrolls to the message. For a call, the embedded player jumps to that moment.
- **Appeal and review.** An appeal targets one criterion and carries a comment. The reviewer sees the disputed score, the comment and the dialog fragment, then upholds or changes it with a reason. The total is recomputed, and the card keeps the original score, the decision and the final score.
- **Model and cost.** Any OpenAI-compatible API. Model name and cost per evaluation (all calls included) are shown on the card.
- **UI.** Plain HTML/CSS/JS with one module per screen, so it can be adapted as a Dynamics 365 HTML web resource. No login.

## Run
```bash
cp .env.example .env      # CQA_API_URL = organizers' GET link without group_id; LLM_* = model
npm start                 # http://localhost:3000 (Node 22.9+, no npm deps); data in ./data
npm test                  # JS scoring tests
cd backend && python -m pytest -q   # Python parity tests (scoring, facts, prompt)
```
Without `LLM_API_KEY` the app runs in **MOCK** mode (rules over the same facts), so the UI works offline.

Storage: local JSON files by default; set `SUPABASE_URL` + `SUPABASE_KEY` to use Postgres (table `cqa_docs`, required on Vercel).

Deploy: `vercel.json` serves `web/` and runs the API as a function (`api/index.mjs`).

Model settings: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_VOTES`, `LLM_CONCURRENCY`, `LLM_PRICE_IN` / `LLM_PRICE_OUT` (USD per 1M tokens, used to estimate cost per evaluation).

## Model and cost
Meta **Muse Spark 1.3** via the Meta API (`muse-spark-1.3`, `reasoning_effort: low`), external API.
One evaluation = 1 model call (+1 repair call only if the answer breaks the format): about **$0.01–0.03** and 20–55 s per dialog
($1.25 / $4.25 per 1M input/output tokens). Facts (timings, greeting, system events) and the total are computed in code.

## Results files (appendix «Как сдать результаты», JSON 1.0)
```
node tools/export-results.mjs https://cqa-bioc.vercel.app --group DEV  --out results/dev/results.json  --expected 65
node tools/export-results.mjs https://cqa-bioc.vercel.app --group <PROD> --out results/prod/results.json --expected 10
```
The script exports the latest evaluation of every dialog (decided appeals applied), validates the format
(8 criteria once each, allowed values, 1-based `evidence_turns`, `critical_flag` = `critical`, no duplicate IDs)
and exits non-zero on any problem. Not-evaluated dialogs are written as `status: "error"`, never as zero.
The same file is available in the UI (button «⤓ results.json») and at `GET /api/export?group=…`.

## Accessibility and themes
One-click profiles in the sidebar (Слабое зрение, Незрячим, Дальтонизм, Дислексия, Без движения, Пожилым); fine-tuning in «♿ Все настройки» (Alt+A): text size 90–160 %, high contrast for low vision, colour-vision-safe palette
(Okabe–Ito, meaning duplicated by ✓ ◐ ✗ icons), readable spacing for dyslexia (WCAG 1.4.12), no animations,
and «🔊 Озвучить» on a dialog card (Web Speech API, reads the total, gross errors and every verdict).
OS settings «reduce motion» / «increase contrast» are honoured automatically. Light / dark / system theme;
Freedom Finance palette (#51AF3D, #0F5431). Skip link, visible focus, keyboard navigation (← → between dialogs, / search).

## Layout
| Path | What |
|---|---|
| `web/` | UI: `screens/dashboard, list, card, checklists, appeals`, `lib/api.js` |
| `server.mjs` | reference API (Node); contract in `API_CONTRACT.md` |
| `lib/` | `facts.mjs`, `evaluator.mjs`, `scoring.mjs`, `store.mjs` |
| `prompts/` | judge prompt shared by JS and Python |
| `checklists/` | `chat.json` (official checklist), `call.json` (speech adaptation) |
| `backend/cqa/` | Python: `scoring.py`, `sanitize.py`, `facts.py`, `evaluator.py`, `audio.py` |
| `test/fixtures/` | parity fixtures generated from the JS reference |
