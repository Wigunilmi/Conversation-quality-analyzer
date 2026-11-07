// Checks that a backend implements API_CONTRACT.md well enough for the UI. Run before switching BACKEND_URL.
// Usage: node tools/check-backend.mjs https://backend.example.com
const B = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
let ok = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); ok++; console.log("✓", name); } catch (e) { fail++; console.log("✗", name, "—", e.message); } };
const j = async (path, body) => { const r = await fetch(B + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${x.error || x.detail || ""}`); return x; };
const has = (o, keys, where) => { for (const k of keys) if (!(k in o)) throw new Error(`${where}: missing "${k}"`); };

let cid, ev, ap;
await t("GET /api/health", async () => has(await j("/api/health"), ["ok", "llm"], "health"));
await t("POST /api/groups/DEV/load", async () => { const r = await j("/api/groups/DEV/load", {}); if (!(r.loaded > 0)) throw new Error("loaded=0"); });
await t("GET /api/groups", async () => { const r = await j("/api/groups"); if (!r.includes("DEV")) throw new Error("DEV missing"); });
await t("GET /api/conversations", async () => { const r = await j("/api/conversations?group=DEV"); has(r[0], ["conversation_id", "channel", "language", "lines", "total", "critical", "outdated", "appeals_open", "preview"], "row"); cid = r.find((x) => x.channel === "agent chat").conversation_id; });
await t("GET /api/checklists", async () => { const r = await j("/api/checklists"); if (r.length < 2) throw new Error("need chat + call sets"); has(r[0], ["id", "name", "channels", "active", "versions", "active_checklist"], "set"); });
await t("POST /api/evaluate", async () => { ev = await j("/api/evaluate", { conversation_id: cid }); has(ev, ["id", "results", "final_results", "totals", "original_totals", "checklist", "appeals", "checklist_id", "checklist_version", "model", "cost_usd", "ms"], "view"); has(ev.totals, ["total", "sections", "critical_errors", "rows", "max_score"], "totals"); has(ev.results[0], ["criterion_id", "na", "explanation", "evidence_ids", "checked_span"], "result"); });
await t("GET /api/conversations/{id}", async () => { const r = await j(`/api/conversations/${cid}`); has(r, ["conversation", "evaluation", "history"], "card"); });
await t("POST /api/conversations (upload)", async () => { const r = await j("/api/conversations", { channel: "agent chat", transcript: [{ timestamp: "00:00", speaker: "client", text: "Здравствуйте" }, { timestamp: "00:10", speaker: "operator", text: "Здравствуйте, меня зовут Анна." }] }); if (!r.ids?.length) throw new Error("no ids"); });
await t("POST /api/appeals", async () => { ap = await j("/api/appeals", { evaluation_id: ev.id, criterion_id: ev.results[0].criterion_id, comment: "contract check" }); has(ap, ["id", "status", "original"], "appeal"); });
await t("POST /api/appeals/{id}/decide + recompute", async () => { const c = ev.checklist.criteria[0]; const r = await j(`/api/appeals/${ap.id}/decide`, { action: "change", reason: "contract check", ...(c.type === "scale" ? { score: c.scale.min } : { answer: ev.results[0].answer === "yes" ? "no" : "yes" }) }); has(r, ["appeal", "evaluation"], "decide"); if (!r.evaluation.final_results.find((x) => x.criterion_id === c.id).overridden) throw new Error("final_results not overridden"); });
await t("GET /api/appeals", async () => { const r = await j("/api/appeals"); if (!r.some((a) => a.id === ap.id)) throw new Error("appeal not listed"); });
await t("GET /api/conversations/{call}/audio", async () => { const rows = await j("/api/conversations?group=DEV"); const call = rows.find((x) => x.channel === "voice call"); if (!call) return; has(await j(`/api/conversations/${call.conversation_id}/audio`), ["src"], "audio"); });
console.log(`\n${ok} passed, ${fail} failed — ${fail ? "НЕ переключать" : "можно переключать BACKEND_URL"}`);
process.exit(fail ? 1 : 0);
