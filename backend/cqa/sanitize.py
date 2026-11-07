"""Port of sanitize() from lib/evaluator.mjs: clean up what the LLM returned before scoring.

Returns (results, problems). If problems is non-empty, ask the model once more with the list
of problems appended (same as the JS repair retry).
"""
from __future__ import annotations

from typing import Any

from .scoring import snap


def sanitize(conv: dict, checklist: dict, raw: dict | None) -> tuple[list[dict], list[str]]:
    n = len(conv["transcript"])
    by_id = {r.get("criterion_id"): r for r in (raw or {}).get("results", []) if isinstance(r, dict)}
    problems: list[str] = []
    results: list[dict] = []
    for c in checklist["criteria"]:
        r: dict[str, Any] = by_id.get(c["id"]) or {}
        if c["id"] not in by_id:
            problems.append(f"{c['id']}: missing")
        na = bool(r.get("na")) and bool(c.get("na_allowed"))
        if r.get("na") and not c.get("na_allowed"):
            problems.append(f"{c['id']}: N/A not allowed")
        raw_ev = r.get("evidence_ids") or []
        evidence: list[int] = []
        for i in raw_ev:
            try:
                i = int(i)
            except (TypeError, ValueError):
                continue
            if 0 <= i < n and i not in evidence:
                evidence.append(i)
        if len(raw_ev) != len(evidence):
            problems.append(f"{c['id']}: bad evidence ids")
        try:
            conf = float(r.get("confidence"))
            conf = max(0.0, min(1.0, conf)) if conf == conf else None
        except (TypeError, ValueError):
            conf = None
        out = {"criterion_id": c["id"], "na": na, "na_reason": (r.get("na_reason") or "") if na else "",
               "explanation": r.get("explanation") or "", "evidence_ids": evidence,
               "checked_span": r.get("checked_span") or "", "confidence": conf,
               "suggestion": r["suggestion"].strip() if isinstance(r.get("suggestion"), str) else ""}
        if not na:
            if c["type"] == "scale":
                out["score"] = snap(c, r.get("score"))
                try:
                    same = float(r.get("score")) == out["score"]
                except (TypeError, ValueError):
                    same = False
                if not same:
                    problems.append(f"{c['id']}: score {r.get('score')} is not an allowed step")
            else:
                out["answer"] = "yes" if r.get("answer") == "yes" else "no"
        results.append(out)
    return results, problems
