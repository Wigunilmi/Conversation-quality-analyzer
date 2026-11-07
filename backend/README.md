# FastAPI backend (port of `server.mjs`)

Reference implementation is the Node server in the repo root. Keep the `/api/...` contract identical so `web/` needs no changes, then delete `server.mjs` + `lib/`.

Already ported, with parity tests against the JS output (`python -m pytest -q` → 479 passed):
- `cqa/scoring.py`: `compute_totals`, `normalize`, `is_critical_fail`, `round_score` (half-up like JS, not Python's banker's `round`), `snap`, `validate_checklist`
- `cqa/sanitize.py`: cleans the LLM answer (N/A only where allowed, valid evidence ids, scale snapped to allowed steps) and returns the problems that trigger one repair retry

```bash
cd backend
pip install pytest fastapi uvicorn
python -m pytest -q          # 479 tests: scoring, facts and prompt parity with JS + scenarios
```

If you change `lib/scoring.mjs` before deleting it, regenerate fixtures with `node test/gen-parity.mjs`.

Also ready: `cqa/facts.py` (deterministic facts), `cqa/evaluator.py` (prompt from `/prompts`, LLM call with retries, repair retry, voting, MOCK), `cqa/audio.py` (resolve the mp3).

Still to do in FastAPI: the routes and storage from `API_CONTRACT.md`. Notes:
- totals are **not stored**: compute them on read from `results` plus decided appeals (`view()` in server.mjs)
- every evaluation stores `checklist_version`
- static files: mount `web/` at `/`
