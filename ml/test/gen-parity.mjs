// Generates test/fixtures/parity.json: random results + the JS scoring output.
// The Python port (backend/tests) must reproduce every case exactly. Run: node test/gen-parity.mjs
import fs from "node:fs";
import { computeTotals } from "../lib/scoring.mjs";
import { snap } from "../lib/evaluator.mjs";

const fb = JSON.parse(fs.readFileSync(new URL("../checklists/chat.json", import.meta.url)));
const variants = [
  fb,
  { ...fb, rounding: { decimals: 0, mode: "half_up" } },
  { ...fb, rounding: { decimals: 1, mode: "floor" }, critical_zeroes_total: true },
  { ...fb, rounding: { decimals: 2, mode: "ceil" } },
];
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const cases = [];
for (let k = 0; k < 400; k++) {
  const cl = variants[k % variants.length];
  const results = cl.criteria.map((c) => {
    if (c.na_allowed && rnd() < 0.3) return { criterion_id: c.id, na: true };
    if (c.type === "scale") return { criterion_id: c.id, score: rnd() < 0.85 ? pick(c.scale.steps).value : Math.round(rnd() * 30 - 5) };
    return { criterion_id: c.id, answer: rnd() < (c.critical_on === "yes" ? 0.15 : 0.7) ? "yes" : "no" };
  });
  cases.push({ variant: variants.indexOf(cl), results, expected: computeTotals(cl, results) });
}
// all-N/A case
cases.push({ variant: 0, results: fb.criteria.map((c) => (c.na_allowed ? { criterion_id: c.id, na: true } : { criterion_id: c.id, answer: "no" })), expected: null });
cases.at(-1).expected = computeTotals(fb, cases.at(-1).results);
const snaps = [];
for (const c of fb.criteria.filter((c) => c.type === "scale")) for (const x of [-3, 0, 1, 2, 2.5, 3, 5.5, 6, 7.5, 8, 11, 12.5, 13, 17.5, 25, "abc"]) snaps.push({ id: c.id, x, expected: snap(c, Number(x)) });
fs.writeFileSync(new URL("./fixtures/parity.json", import.meta.url), JSON.stringify({ variants, cases, snaps }));
console.log(`${cases.length} cases, ${snaps.length} snaps`);
