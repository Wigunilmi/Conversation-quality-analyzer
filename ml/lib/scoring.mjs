// Deterministic scoring. The LLM only answers each criterion; every number here is computed in code.
//
// Checklist criterion:
//   { id, section, text, weight, type: "binary" | "scale", scale: {min, max}, na_allowed, critical }
// Criterion result (from the evaluator or a reviewer):
//   { criterion_id, na, answer, score, ... }
//   binary → answer "yes" | "no"; scale → score within [min, max]

export function normalize(criterion, result) {
  if (!result || result.na) return null;
  if (criterion.type === "scale") {
    const { min = 0, max = 1 } = criterion.scale || {};
    const s = clamp(Number(result.score), min, max);
    return max === min ? 1 : (s - min) / (max - min);
  }
  return result.answer === "yes" ? 1 : 0;
}

// Gross-error criterion. critical_on: "yes" → answering "yes" means a violation was found
// (Freedom checklist item 08). Otherwise a critical criterion fails when it scores 0.
export const isFlag = (c) => !!c.critical && c.critical_on === "yes";
export function isCriticalFail(criterion, result) {
  if (!criterion.critical || !result || result.na) return false;
  if (isFlag(criterion)) return result.answer === "yes";
  return normalize(criterion, result) === 0;
}

export function round(value, rounding = { decimals: 0, mode: "half_up" }) {
  const f = 10 ** (rounding.decimals ?? 0);
  const x = value * f;
  const r = rounding.mode === "floor" ? Math.floor(x + 1e-9)
    : rounding.mode === "ceil" ? Math.ceil(x - 1e-9)
    : Math.round(x + 1e-9);
  return r / f;
}

// N/A redistribution: the weight of N/A criteria is spread proportionally over the applicable
// ones, which is the same as dividing by the sum of applicable weights.
function aggregate(criteria, byId, rounding, maxScore) {
  let wSum = 0, acc = 0;
  const rows = [];
  for (const c of criteria) {
    if (isFlag(c)) continue; // flagged separately, never scored
    const r = byId[c.id];
    const n = normalize(c, r);
    if (n === null) { rows.push({ id: c.id, applicable: false, weight: c.weight, effective_weight: 0, points: 0 }); continue; }
    wSum += c.weight; acc += c.weight * n;
    rows.push({ id: c.id, applicable: true, weight: c.weight, normalized: n });
  }
  for (const row of rows) {
    if (!row.applicable) continue;
    row.effective_weight = wSum ? row.weight / wSum : 0;
    row.points = row.effective_weight * row.normalized * maxScore;
  }
  // "Если применимых критериев с весом нет, итог не рассчитывается" → null.
  const total = wSum ? round((acc / wSum) * maxScore, rounding) : null; // null = everything N/A
  return { total, rows };
}

export function computeTotals(checklist, results) {
  const byId = Object.fromEntries(results.map((r) => [r.criterion_id, r]));
  const rounding = checklist.rounding || { decimals: 0, mode: "half_up" };
  const maxScore = checklist.max_score ?? 100;
  const { total, rows } = aggregate(checklist.criteria, byId, rounding, maxScore);

  const sections = {};
  for (const name of [...new Set(checklist.criteria.map((c) => c.section).filter(Boolean))]) {
    sections[name] = aggregate(checklist.criteria.filter((c) => c.section === name), byId, rounding, maxScore).total;
  }

  const critical = checklist.criteria.filter((c) => isCriticalFail(c, byId[c.id])).map((c) => c.id);
  // Gross error is flagged separately. If the checklist says it zeroes the total, apply that too.
  const final = critical.length && checklist.critical_zeroes_total ? 0 : total;
  return { total: final, raw_total: total, max_score: maxScore, sections, critical_errors: critical, rows };
}

export function validateChecklist(cl) {
  const errors = [];
  if (!cl || !Array.isArray(cl.criteria) || !cl.criteria.length) errors.push("criteria must be a non-empty array");
  const ids = new Set();
  for (const c of cl?.criteria || []) {
    if (!c.id) errors.push("criterion without id");
    if (ids.has(c.id)) errors.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.text) errors.push(`${c.id}: empty text`);
    if (!(c.weight >= 0)) errors.push(`${c.id}: weight must be >= 0`);
    if (!["binary", "scale"].includes(c.type)) errors.push(`${c.id}: type must be binary or scale`);
    if (c.type === "scale" && !(c.scale && c.scale.max > c.scale.min)) errors.push(`${c.id}: scale needs min < max`);
    if (c.type === "scale" && c.scale?.steps?.some((s) => s.value < c.scale.min || s.value > c.scale.max)) errors.push(`${c.id}: scale step outside min..max`);
  }
  return errors;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, Number.isFinite(x) ? x : a));
