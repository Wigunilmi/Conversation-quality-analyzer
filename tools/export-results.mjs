// Writes results/<set>/results.json in Freedom's "Формат JSON 1.0" from a running server and validates it.
// Usage: node tools/export-results.mjs <server-url> --group DEV --out results/dev/results.json [--expected 65] [--team BIOC]
// Uses only public read endpoints, so it works against any deployed version.
import fs from "node:fs";
import path from "node:path";
import { buildResults, validateResults } from "../lib/results.mjs";
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const B = (args.find((a) => a.startsWith("http")) || "http://localhost:3000").replace(/\/$/, "");
const group = opt("--group", "DEV"), out = opt("--out", `results/${group.toLowerCase()}/results.json`), expected = opt("--expected") ? Number(opt("--expected")) : undefined;
const get = async (p) => { const r = await fetch(B + p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
const rows = await get(`/api/conversations?group=${encodeURIComponent(group)}`);
const items = [];
for (let i = 0; i < rows.length; i += 8) items.push(...(await Promise.all(rows.slice(i, i + 8).map(async (r) => { const x = await get(`/api/conversations/${encodeURIComponent(r.conversation_id)}`); return { conversation: x.conversation, evaluation: x.evaluation }; }))));
const doc = buildResults(items, { team: opt("--team") });
const problems = validateResults(doc, { expected });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");
const err = doc.results.filter((r) => r.status === "error").length, crit = doc.results.filter((r) => r.score?.critical_flag).length;
console.log(`${out}: ${doc.results.length} записей (ok ${doc.results.length - err}, error ${err}), грубых ${crit}, модель ${doc.model.name}`);
console.log(problems.length ? `ПРОБЛЕМЫ (${problems.length}):\n  ` + problems.join("\n  ") : "Формат JSON 1.0: проверка пройдена ✓");
process.exit(problems.length ? 1 : 0);
