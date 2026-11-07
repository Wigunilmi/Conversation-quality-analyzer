"""Python scoring must match the JS reference (lib/scoring.mjs) exactly."""
import json
import math
from pathlib import Path

import pytest

from cqa.scoring import compute_totals, round_score, snap, validate_checklist

ROOT = Path(__file__).resolve().parents[2]
FB = json.loads((ROOT / "checklists" / "chat.json").read_text())
PARITY = json.loads((ROOT / "test" / "fixtures" / "parity.json").read_text())


def close(a, b):
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
    return a == b


@pytest.mark.parametrize("i", range(len(PARITY["cases"])))
def test_parity_with_js(i):
    case = PARITY["cases"][i]
    got = compute_totals(PARITY["variants"][case["variant"]], case["results"])
    assert close(got, case["expected"]), (got, case["expected"])


def test_snap_parity():
    by_id = {c["id"]: c for c in FB["criteria"]}
    for s in PARITY["snaps"]:
        x = s["x"] if s["x"] != "abc" else float("nan")
        assert snap(by_id[s["id"]], x) == s["expected"], s


def full(over=None):
    over = over or {}
    out = []
    for c in FB["criteria"]:
        r = {"criterion_id": c["id"]}
        if c["type"] == "scale":
            r["score"] = c["scale"]["max"]
        else:
            r["answer"] = "no" if c.get("critical_on") == "yes" else "yes"
        r.update(over.get(c["id"], {}))
        out.append(r)
    return out


def test_perfect_chat_is_100():
    assert sum(c["weight"] for c in FB["criteria"]) == 100
    assert compute_totals(FB, full())["total"] == 100


def test_na_identification_partial_scales():
    t = compute_totals(FB, full({"c03_identification": {"na": True}, "c04_consultation": {"score": 15}, "c06_management": {"score": 7}}))
    assert t["total"] == 88.13


def test_gross_error_flagged_not_scored():
    t = compute_totals(FB, full({"c08_gross": {"answer": "yes"}}))
    assert t["total"] == 100 and t["critical_errors"] == ["c08_gross"]


def test_all_na_total_is_none():
    cl = {"max_score": 100, "criteria": [
        {"id": "a", "text": "t", "weight": 10, "type": "binary", "na_allowed": True},
        {"id": "g", "text": "t", "weight": 0, "type": "binary", "critical": True, "critical_on": "yes"}]}
    assert compute_totals(cl, [{"criterion_id": "a", "na": True}, {"criterion_id": "g", "answer": "no"}])["total"] is None


def test_rounding_half_up_not_bankers():
    assert round_score(88.125, {"decimals": 2}) == 88.13
    assert round_score(0.5) == 1
    assert round_score(71.99, {"decimals": 0, "mode": "floor"}) == 71


def test_validate():
    assert validate_checklist(FB) == []
    assert validate_checklist({"criteria": [{"id": "a", "text": "t", "weight": 1, "type": "scale", "scale": {"min": 2, "max": 2}}]})


def test_sanitize():
    from cqa.sanitize import sanitize
    conv = {"transcript": [{}, {}, {}]}
    res, problems = sanitize(conv, FB, {"results": [
        {"criterion_id": "c01_contact", "na": True, "evidence_ids": [1, 9]},
        {"criterion_id": "c06_management", "score": 8}]})
    by = {r["criterion_id"]: r for r in res}
    assert by["c01_contact"]["na"] is False and by["c01_contact"]["evidence_ids"] == [1]
    assert by["c06_management"]["score"] == 7
    assert any("not allowed" in p for p in problems) and any("not an allowed step" in p for p in problems)
