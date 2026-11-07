// Accuracy vs. our own reference labels (ground truth made by the team).
// labels file: [{ "conversation_id": "p1-ru-001", "results": { "c01_contact": "yes" | "no" | "na" | <score>, ... } }]
// Usage (server running):  node tools/accuracy.mjs labels/dev-gold.json [http://localhost:3000]
import fs from "node:fs";
import { computeTotals } from "../lib/scoring.mjs";

const [file, base = "http://localhost:3000"] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(file, "utf8"));
const per = {}; let fullN = 0, n = 0, totalAbs = 0, exactDialogs = 0, grossHit = 0, grossN = 0;
for (const g of gold) {
  const { evaluation: ev } = await (await fetch(`${base}/api/conversations/${encodeURIComponent(g.conversation_id)}`)).json();
  if (!ev) { console.log(`- ${g.conversation_id}: not evaluated`); continue; }
  const cl = ev.checklist; let allOk = true;
  const goldResults = cl.criteria.map((c) => {
    const v = g.results[c.id];
    return v === "na" ? { criterion_id: c.id, na: true } : c.type === "scale" ? { criterion_id: c.id, score: Number(v) } : { criterion_id: c.id, answer: v };
  });
  for (const c of cl.criteria) {
    const want = g.results[c.id]; if (want === undefined) continue;
    const r = ev.results.find((x) => x.criterion_id === c.id);
    const got = r.na ? "na" : c.type === "scale" ? String(r.score) : r.answer;
    const ok = got === String(want);
    (per[c.id] ||= { name: c.text, ok: 0, n: 0, misses: [] }); per[c.id].n++; if (ok) per[c.id].ok++; else { allOk = false; per[c.id].misses.push(`${g.conversation_id}: model=${got} gold=${want}`); }
    if (c.critical_on === "yes") { grossN++; if (ok) grossHit++; }
  }
  n++; if (allOk) exactDialogs++;
  if (cl.criteria.every((c) => g.results[c.id] !== undefined)) { const gt = computeTotals(cl, goldResults).total, mt = computeTotals(cl, ev.results).total; totalAbs += Math.abs((gt ?? 0) - (mt ?? 0)); fullN = (fullN || 0) + 1; }
}
console.log(`\nDialogs: ${n} · fully matching: ${exactDialogs} · mean |total − gold| = ${fullN ? (totalAbs / fullN).toFixed(2) : "—"} (on ${fullN} fully labelled) · gross-error flag accuracy ${grossHit}/${grossN}\n`);
for (const [id, p] of Object.entries(per)) {
  console.log(`${String(Math.round((p.ok / p.n) * 100)).padStart(3)}%  ${id}  ${p.name}`);
  p.misses.slice(0, 5).forEach((m) => console.log(`        ✗ ${m}`));
}
