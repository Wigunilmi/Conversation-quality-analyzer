import json
from pathlib import Path

import pytest

from cqa.evaluator import build_prompt, evaluate, vote
from cqa.scoring import compute_totals

ROOT = Path(__file__).resolve().parents[2]
PROMPTS = json.loads((ROOT / "test" / "fixtures" / "prompts.json").read_text())
CL = {f: json.loads((ROOT / "checklists" / f"{f}.json").read_text()) for f in ("chat", "call")}


@pytest.mark.parametrize("i", range(len(PROMPTS)))
def test_prompt_parity_with_js(i):
    c = PROMPTS[i]
    assert build_prompt(c["conv"], CL[c["checklist_id"]], examples=c.get("examples")) == c["prompt"]


def test_mock_evaluate_runs_and_scores(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    conv = next(p["conv"] for p in PROMPTS if p["conv"]["channel"] == "voice call")
    out = evaluate(conv, CL["call"])
    t = compute_totals(CL["call"], out["results"])
    assert out["model"].startswith("MOCK") and "facts" in out
    assert t["critical_errors"] == ["c08_gross"]  # synthetic call offers a paid private consultation


def test_vote_majority_and_median():
    cl = {"criteria": [{"id": "a", "type": "binary"}, {"id": "s", "type": "scale", "scale": {"min": 0, "max": 10}}]}
    runs = [[{"criterion_id": "a", "na": False, "answer": a}, {"criterion_id": "s", "na": False, "score": s}] for a, s in (("yes", 10), ("no", 7), ("yes", 4))]
    v = {r["criterion_id"]: r for r in vote(cl, runs)}
    assert v["a"]["answer"] == "yes" and v["a"]["confidence"] == 0.67
    assert v["s"]["score"] == 7
