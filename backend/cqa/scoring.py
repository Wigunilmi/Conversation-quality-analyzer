"""Deterministic scoring — Python port of lib/scoring.mjs (must return identical numbers).

The LLM only answers each criterion; every number here is computed in code.

Criterion: {id, section, text, weight, type: "binary"|"scale", scale: {min, max, steps}, na_allowed,
            critical, critical_on}
Result:    {criterion_id, na, answer ("yes"|"no") | score}
"""
from __future__ import annotations

import math
from typing import Any

Checklist = dict[str, Any]
Result = dict[str, Any]

_EPS = 1e-9


def _num(x: Any, default: float) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def normalize(criterion: dict, result: Result | None) -> float | None:
    """0..1, or None when N/A / missing."""
    if not result or result.get("na"):
        return None
    if criterion.get("type") == "scale":
        sc = criterion.get("scale") or {}
        lo, hi = sc.get("min", 0), sc.get("max", 1)
        s = min(hi, max(lo, _num(result.get("score"), lo)))
        return 1.0 if hi == lo else (s - lo) / (hi - lo)
    return 1.0 if result.get("answer") == "yes" else 0.0


def is_flag(c: dict) -> bool:
    """Gross-error criterion where "yes" means a violation was found (checklist item 08)."""
    return bool(c.get("critical")) and c.get("critical_on") == "yes"


def is_critical_fail(c: dict, result: Result | None) -> bool:
    if not c.get("critical") or not result or result.get("na"):
        return False
    if is_flag(c):
        return result.get("answer") == "yes"
    return normalize(c, result) == 0


def round_score(value: float, rounding: dict | None = None) -> float:
    """Same as JS: half-up (not banker's), with the same epsilon."""
    rounding = rounding or {"decimals": 0, "mode": "half_up"}
    f = 10 ** rounding.get("decimals", 0)
    x = value * f
    mode = rounding.get("mode", "half_up")
    if mode == "floor":
        r = math.floor(x + _EPS)
    elif mode == "ceil":
        r = math.ceil(x - _EPS)
    else:
        r = math.floor(x + _EPS + 0.5)  # == JS Math.round(x + 1e-9)
    return r / f


def _aggregate(criteria: list[dict], by_id: dict, rounding: dict, max_score: float):
    w_sum = acc = 0.0
    rows: list[dict] = []
    for c in criteria:
        if is_flag(c):
            continue  # flagged separately, never scored
        n = normalize(c, by_id.get(c["id"]))
        if n is None:
            rows.append({"id": c["id"], "applicable": False, "weight": c["weight"], "effective_weight": 0, "points": 0})
            continue
        w_sum += c["weight"]
        acc += c["weight"] * n
        rows.append({"id": c["id"], "applicable": True, "weight": c["weight"], "normalized": n})
    for row in rows:
        if row["applicable"]:
            row["effective_weight"] = row["weight"] / w_sum if w_sum else 0
            row["points"] = row["effective_weight"] * row["normalized"] * max_score
    # "Если применимых критериев с весом нет, итог не рассчитывается" -> None
    total = round_score(acc / w_sum * max_score, rounding) if w_sum else None
    return total, rows


def compute_totals(checklist: Checklist, results: list[Result]) -> dict:
    by_id = {r["criterion_id"]: r for r in results}
    rounding = checklist.get("rounding") or {"decimals": 0, "mode": "half_up"}
    max_score = checklist.get("max_score", 100)
    criteria = checklist["criteria"]
    total, rows = _aggregate(criteria, by_id, rounding, max_score)

    sections: dict[str, float | None] = {}
    for name in dict.fromkeys(c.get("section") for c in criteria if c.get("section")):
        sections[name] = _aggregate([c for c in criteria if c.get("section") == name], by_id, rounding, max_score)[0]

    critical = [c["id"] for c in criteria if is_critical_fail(c, by_id.get(c["id"]))]
    final = 0 if critical and checklist.get("critical_zeroes_total") else total
    return {"total": final, "raw_total": total, "max_score": max_score, "sections": sections,
            "critical_errors": critical, "rows": rows}


def snap(c: dict, x: Any) -> float:
    """Nearest allowed step; ties keep the earlier step (same as JS reduce)."""
    sc = c["scale"]
    try:
        x = float(x)
    except (TypeError, ValueError):
        return sc["min"]
    if not math.isfinite(x):
        return sc["min"]
    steps = sc.get("steps") or []
    if steps:
        best = steps[0]["value"]
        for s in steps[1:]:
            if abs(s["value"] - x) < abs(best - x):
                best = s["value"]
        return best
    return min(sc["max"], max(sc["min"], math.floor(x + 0.5)))


def validate_checklist(cl: Checklist | None) -> list[str]:
    errors: list[str] = []
    crit = (cl or {}).get("criteria")
    if not isinstance(crit, list) or not crit:
        errors.append("criteria must be a non-empty array")
    ids: set = set()
    for c in crit or []:
        cid = c.get("id")
        if not cid:
            errors.append("criterion without id")
        if cid in ids:
            errors.append(f"duplicate id {cid}")
        ids.add(cid)
        if not c.get("text"):
            errors.append(f"{cid}: empty text")
        if not (isinstance(c.get("weight"), (int, float)) and c["weight"] >= 0):
            errors.append(f"{cid}: weight must be >= 0")
        if c.get("type") not in ("binary", "scale"):
            errors.append(f"{cid}: type must be binary or scale")
        sc = c.get("scale") or {}
        if c.get("type") == "scale" and not ("min" in sc and "max" in sc and sc["max"] > sc["min"]):
            errors.append(f"{cid}: scale needs min < max")
        if c.get("type") == "scale" and any(s["value"] < sc.get("min", 0) or s["value"] > sc.get("max", 0) for s in sc.get("steps") or []):
            errors.append(f"{cid}: scale step outside min..max")
    return errors
