// ML review of a full run, via the public API (the model key stays in the server's env).
// Usage: node tools/review.mjs https://cqa-bioc.vercel.app [--evaluate] [--group DEV]
//   --evaluate  evaluate every dialog first (4 in parallel), then review
// Prints: answer distribution per criterion, N/A rates, RU/KZ/EN consistency of parallel scenarios,
// gross-error detections, repair/problem counts, cost and latency.
const args = process.argv.slice(2);
const B = (args.find((a) => a.startsWith("http")) || "http://localhost:3000").replace(/\/$/, "");
const group = args.includes("--group") ? args[args.indexOf("--group") + 1] : "DEV";
const j = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const x = await r.json(); if (!r.ok) throw new Error(`${p}: ${r.status} ${x.error || ""}`); return x; };

const health = await j("/api/health");
console.log(`Server: ${B} · model: ${health.llm} · store: ${health.store}\n`);
let rows = await j(`/api/conversations?group=${group}`);
if (args.includes("--evaluate")) {
  let i = 0, done = 0, failed = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < rows.length) { const r = rows[i++]; try { await j("/api/evaluate", { conversation_id: r.conversation_id }); } catch (e) { failed.push(`${r.conversation_id}: ${e.message}`); } process.stdout.write(`\r${++done}/${rows.length}`); }
  }));
  console.log(`\nEvaluated in ${((Date.now() - t0) / 1000).toFixed(0)} s${failed.length ? `, failed ${failed.length}:\n  ` + failed.join("\n  ") : ""}\n`);
  rows = await j(`/api/conversations?group=${group}`);
}

const cards = [];
for (const r of rows) { const c = await j(`/api/conversations/${encodeURIComponent(r.conversation_id)}`); if (c.evaluation) cards.push(c); }
if (!cards.length) { console.log("No evaluations yet. Run with --evaluate."); process.exit(0); }
const key = (c, r) => (!r ? "?" : r.na ? "N/A" : c.type === "scale" ? String(r.score) : r.answer);
const crit = cards[0].evaluation.checklist.criteria;

console.log("== Answers per criterion (chats | calls) ==");
for (const c of crit) {
  for (const ch of ["agent chat", "voice call"]) {
    const vals = cards.filter((x) => x.conversation.channel === ch).map((x) => key(c, x.evaluation.results.find((r) => r.criterion_id === c.id)));
    const dist = {}; vals.forEach((v) => (dist[v] = (dist[v] || 0) + 1));
    if (vals.length) console.log(`${c.id.padEnd(20)} ${ch === "agent chat" ? "chat" : "call"}  ${Object.entries(dist).sort().map(([k, n]) => `${k}:${n}`).join("  ")}`);
  }
}

console.log("\n== RU / KZ / EN consistency (same timestamps + speakers; NOT always translations — check text) ==");
const sc = {};
for (const x of cards) { const k = x.conversation.transcript.map((t) => `${t.timestamp}|${t.speaker}`).join(";"); (sc[k] ||= []).push(x); }
for (const k of Object.keys(sc)) { const langs = new Set(sc[k].map((x) => x.conversation.language)); if (langs.size < 2) delete sc[k]; else { sc[sc[k].map((x) => x.conversation.conversation_id).join("=")] = sc[k]; delete sc[k]; } }
let agree = 0, total = 0;
for (const [k, arr] of Object.entries(sc)) {
  if (arr.length < 2) continue;
  for (const c of crit) {
    const vals = arr.map((x) => key(c, x.evaluation.results.find((r) => r.criterion_id === c.id)));
    total++; if (new Set(vals).size === 1) agree++;
    else console.log(`  ${k} ${c.id}: ${arr.map((x, i) => `${x.conversation.language}=${vals[i]}`).join(" ")}`);
  }
}
console.log(`  agreement ${total ? Math.round((agree / total) * 100) : "—"}% (${agree}/${total})`);

console.log("\n== Gross errors (criterion 08) ==");
for (const x of cards) { const g = x.evaluation.totals.critical_errors; if (g.length) { const r = x.evaluation.results.find((y) => y.criterion_id === g[0]); console.log(`  ${x.conversation.conversation_id}: ${r.explanation}`); } }

console.log("\n== Totals ==");
const totals = cards.map((x) => x.evaluation.totals.total).filter((t) => t !== null);
console.log(`  avg ${(totals.reduce((s, t) => s + t, 0) / totals.length).toFixed(2)} · min ${Math.min(...totals)} · max ${Math.max(...totals)} · N/A totals ${cards.length - totals.length}`);
const probs = cards.flatMap((x) => (x.evaluation.problems || []).map((p) => `${x.conversation.conversation_id}: ${p}`));
console.log(`  model answers needing repair: ${probs.length}${probs.length ? "\n    " + probs.slice(0, 10).join("\n    ") : ""}`);
const cost = cards.reduce((s, x) => s + (x.evaluation.cost_usd || 0), 0), ms = cards.reduce((s, x) => s + (x.evaluation.ms || 0), 0);
console.log(`  cost $${cost.toFixed(4)} total, $${(cost / cards.length).toFixed(5)} per dialog · avg ${(ms / cards.length / 1000).toFixed(1)} s per dialog`);
