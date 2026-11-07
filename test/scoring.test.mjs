import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, round, validateChecklist } from "../lib/scoring.mjs";
import { sanitize } from "../lib/evaluator.mjs";

const cl = {
  max_score: 100, rounding: { decimals: 0, mode: "half_up" },
  criteria: [
    { id: "a", text: "t", section: "S1", weight: 50, type: "binary" },
    { id: "b", text: "t", section: "S1", weight: 30, type: "scale", scale: { min: 0, max: 2 }, na_allowed: true },
    { id: "c", text: "t", section: "S2", weight: 20, type: "binary", na_allowed: true },
    { id: "x", text: "t", weight: 0, type: "binary", critical: true },
  ],
};

test("weighted scale score", () => {
  const t = computeTotals(cl, [
    { criterion_id: "a", answer: "yes" }, { criterion_id: "b", score: 1 }, { criterion_id: "c", answer: "no" }, { criterion_id: "x", answer: "yes" },
  ]);
  assert.equal(t.total, 65); // 50 + 30*0.5 + 0
  assert.deepEqual(t.critical_errors, []);
});

test("N/A weight is redistributed over applicable criteria", () => {
  const t = computeTotals(cl, [
    { criterion_id: "a", answer: "yes" }, { criterion_id: "b", na: true }, { criterion_id: "c", answer: "no" }, { criterion_id: "x", answer: "yes" },
  ]);
  assert.equal(t.total, round((50 / 70) * 100)); // 71
  assert.equal(t.rows.find((r) => r.id === "b").effective_weight, 0);
});

test("sections and critical error flag", () => {
  const t = computeTotals({ ...cl, critical_zeroes_total: true }, [
    { criterion_id: "a", answer: "yes" }, { criterion_id: "b", score: 2 }, { criterion_id: "c", na: true }, { criterion_id: "x", answer: "no" },
  ]);
  assert.equal(t.sections.S1, 100);
  assert.equal(t.sections.S2, null);
  assert.deepEqual(t.critical_errors, ["x"]);
  assert.equal(t.total, 0);
  assert.equal(t.raw_total, 100);
});

test("rounding modes", () => {
  assert.equal(round(71.45, { decimals: 1 }), 71.5);
  assert.equal(round(71.99, { decimals: 0, mode: "floor" }), 71);
});

test("checklist validation", () => {
  assert.deepEqual(validateChecklist(cl), []);
  assert.ok(validateChecklist({ criteria: [{ id: "a", text: "t", weight: 1, type: "scale", scale: { min: 2, max: 2 } }] }).length);
});

test("sanitize drops bad evidence and illegal N/A", () => {
  const conv = { transcript: [{}, {}, {}] };
  const { results, problems } = sanitize(conv, { criteria: [{ id: "a", text: "t", type: "binary", na_allowed: false }] }, { results: [{ criterion_id: "a", na: true, evidence_ids: [1, 9] }] });
  assert.equal(results[0].na, false);
  assert.deepEqual(results[0].evidence_ids, [1]);
  assert.equal(problems.length, 2);
});

// ---- the organizers' checklist (checklists/chat.json) ----
import fs from "node:fs";
import { snap } from "../lib/evaluator.mjs";
const fb = JSON.parse(fs.readFileSync(new URL("../checklists/chat.json", import.meta.url)));
const all = (over = {}) => fb.criteria.map((c) => ({ criterion_id: c.id, ...(c.type === "scale" ? { score: c.scale.max } : { answer: c.critical_on === "yes" ? "no" : "yes" }), ...(over[c.id] || {}) }));

test("Freedom checklist: perfect chat = 100, weights sum to 100", () => {
  assert.equal(fb.criteria.reduce((s, c) => s + c.weight, 0), 100);
  assert.equal(computeTotals(fb, all()).total, 100);
});

test("Freedom checklist: N/A identification + partial scales, rounded to 2 decimals", () => {
  // applicable weights 80; points: 10 + 15 + 20*15/20 + 15 + 15*7/10 + 5 = 70.5 → 70.5/80*100 = 88.125
  const t = computeTotals(fb, all({ c03_identification: { na: true }, c04_consultation: { score: 15 }, c06_management: { score: 7 } }));
  assert.equal(t.total, 88.13);
});

test("Freedom checklist: gross error is flagged, not scored", () => {
  const t = computeTotals(fb, all({ c08_gross: { answer: "yes" } }));
  assert.equal(t.total, 100);
  assert.deepEqual(t.critical_errors, ["c08_gross"]);
});

test("all weighted criteria N/A → total is not calculated (null)", () => {
  const cl2 = { max_score: 100, criteria: [{ id: "a", text: "t", weight: 10, type: "binary", na_allowed: true }, { id: "g", text: "t", weight: 0, type: "binary", critical: true, critical_on: "yes" }] };
  const t = computeTotals(cl2, [{ criterion_id: "a", na: true }, { criterion_id: "g", answer: "no" }]);
  assert.equal(t.total, null);
});

test("scale scores snap to allowed steps", () => {
  const c = fb.criteria.find((x) => x.id === "c06_management");
  assert.equal(snap(c, 8), 7);
  assert.equal(snap(c, 6), 7);
  assert.equal(snap(c, 1), 0);
});
