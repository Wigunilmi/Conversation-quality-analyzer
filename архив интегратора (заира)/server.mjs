// Reference API (Node, zero dependencies). The FastAPI backend mirrors this contract — see API_CONTRACT.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { load, save, newId } from "./lib/store.mjs";
import { evaluate } from "./lib/evaluator.mjs";
import { computeTotals, validateChecklist } from "./lib/scoring.mjs";

const PORT = Number(process.env.PORT || 3000);
const WEB = path.resolve("web");

// ---------- data ----------
async function fetchGroup(groupId) {
  const base = process.env.CQA_API_URL;
  if (!base) throw httpError(500, "CQA_API_URL is not set (see .env.example)");
  const url = `${base}${base.includes("?") ? "&" : "?"}group_id=${encodeURIComponent(groupId)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j.isSuccess) throw httpError(502, `Organizers API: ${j.error || res.status}`);
  const convs = load("conversations", {});
  for (const r of j.data.records) convs[r.conversation_id] = { ...r, group_id: groupId, loaded_at: new Date().toISOString() };
  save("conversations", convs);
  return j.data.records.length;
}

// Checklist sets: one per kind (chat, call, custom…), each versioned and bound to channels.
function sets() {
  let st = load("checklist_sets", null);
  if (!st) {
    const seed = ["chat", "call"].map((f) => JSON.parse(fs.readFileSync(`checklists/${f}.json`, "utf8")));
    st = seed.map((cl) => ({ id: cl.id, name: cl.name, channels: cl.channels || [], active: 1, versions: [{ version: 1, created_at: new Date().toISOString(), note: "Исходная версия", checklist: cl }] }));
    save("checklist_sets", st);
  }
  return st;
}
const activeOf = (s) => s.versions.find((v) => v.version === s.active);
const setFor = (channel) => sets().find((s) => s.channels.includes(channel)) || sets()[0];
const checklistAt = (setId, version) => sets().find((s) => s.id === setId)?.versions.find((v) => v.version === version)?.checklist;

const REVIEW_CONF = 0.67; // criteria with lower model confidence go to the human review queue

// Final results = model results with decided appeals applied on top. Totals are recomputed on every read.
function view(ev, { full = true } = {}) {
  const cl = checklistAt(ev.checklist_id, ev.checklist_version);
  const appeals = load("appeals", []).filter((a) => a.evaluation_id === ev.id);
  const final = ev.results.map((r) => {
    const a = appeals.find((x) => x.criterion_id === r.criterion_id && x.status === "changed");
    return a ? { ...r, ...a.decision.result, overridden: true, appeal_id: a.id } : r;
  });
  const low = ev.results.filter((r) => r.confidence !== null && r.confidence !== undefined && r.confidence < REVIEW_CONF).map((r) => r.criterion_id);
  const out = { ...ev, appeals, final_results: final, original_totals: computeTotals(cl, ev.results), totals: computeTotals(cl, final), checklist: cl, low_confidence: low };
  if (!full) { delete out.trace; delete out.checklist; }
  return out;
}
const evals = () => load("evaluations", []);
const latestEval = (cid, all = evals()) => { for (let i = all.length - 1; i >= 0; i--) if (all[i].conversation_id === cid) return all[i]; };

async function runEvaluation(cid) {
  const conv = load("conversations", {})[cid];
  if (!conv) throw httpError(404, `conversation ${cid} not loaded`);
  const s = setFor(conv.channel); const v = activeOf(s);
  const t0 = Date.now();
  const out = await evaluate(conv, v.checklist);
  const ev = { id: newId("ev"), conversation_id: cid, group_id: conv.group_id, checklist_id: s.id, checklist_name: s.name, checklist_version: v.version, created_at: new Date().toISOString(), ms: Date.now() - t0, ...out };
  const all = evals(); all.push(ev); save("evaluations", all);
  return view(ev);
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, ...(await fn(items[k])) }; } catch (e) { out[k] = { ok: false, error: e.message }; } }
  }));
  return out;
}

function listRows(group) {
  const all = evals();
  return Object.values(load("conversations", {})).filter((c) => !group || c.group_id === group).map((c) => {
    const ev = latestEval(c.conversation_id, all); const v = ev && view(ev, { full: false });
    const cur = setFor(c.channel);
    return {
      conversation_id: c.conversation_id, group_id: c.group_id, channel: c.channel, language: c.language, lines: c.transcript.length,
      total: v?.totals.total ?? null, original_total: v?.original_totals.total ?? null, critical: v?.totals.critical_errors || [],
      checklist_id: ev?.checklist_id ?? null, checklist_version: ev?.checklist_version ?? null,
      outdated: !!ev && (ev.checklist_id !== cur.id || ev.checklist_version !== cur.active),
      low_confidence: v?.low_confidence.length || 0,
      appeals_open: v?.appeals.filter((a) => a.status === "open").length || 0, appeals_total: v?.appeals.length || 0,
      evaluated_at: ev?.created_at ?? null, model: ev?.model ?? null, cost_usd: ev?.cost_usd ?? null, ms: ev?.ms ?? null,
      preview: (c.transcript.find((t) => t.speaker === "client")?.text || "").slice(0, 120),
    };
  });
}

// ---------- routes ----------
const routes = {
  "GET /api/health": async () => ({ ok: true, llm: process.env.LLM_API_KEY ? process.env.LLM_MODEL || "gpt-4.1-mini" : "MOCK", votes: Number(process.env.LLM_VOTES || 1) }),

  "POST /api/groups/:gid/load": async ({ gid }) => ({ loaded: await fetchGroup(gid) }),
  "GET /api/groups": async () => [...new Set(Object.values(load("conversations", {})).map((c) => c.group_id))],

  "GET /api/conversations": async (_, q) => listRows(q.group),

  "GET /api/conversations/:cid": async ({ cid }) => {
    const conv = load("conversations", {})[cid];
    if (!conv) throw httpError(404, "not found");
    const all = evals().filter((e) => e.conversation_id === cid);
    const ev = all.at(-1);
    return { conversation: conv, evaluation: ev ? view(ev) : null, history: all.map((e) => ({ id: e.id, created_at: e.created_at, checklist_id: e.checklist_id, checklist_version: e.checklist_version, model: e.model, total: view(e, { full: false }).totals.total })) };
  },

  // The organizers' audio_url is an HTML player page; the real mp3 is a short-lived signed link inside it.
  "GET /api/conversations/:cid/audio": async ({ cid }) => {
    const conv = load("conversations", {})[cid];
    if (!conv?.audio_url) throw httpError(404, "no audio");
    const html = await (await fetch(conv.audio_url)).text();
    const m = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/<audio[^>]+src="([^"]+)"/i);
    if (!m) throw httpError(502, "audio source not found");
    return { src: m[1].replace(/&amp;/g, "&"), page: conv.audio_url };
  },

  "POST /api/evaluate": async (_, __, body) => runEvaluation(body.conversation_id),

  "POST /api/evaluate-batch": async (_, __, body) => {
    const all = evals();
    const ids = Object.values(load("conversations", {}))
      .filter((c) => !body.group_id || c.group_id === body.group_id)
      .filter((c) => { if (!body.only_missing) return true; const ev = latestEval(c.conversation_id, all); const s = setFor(c.channel); return !ev || ev.checklist_id !== s.id || ev.checklist_version !== s.active; })
      .map((c) => c.conversation_id);
    const t0 = Date.now();
    const res = await pool(ids, Number(body.concurrency || process.env.LLM_CONCURRENCY || 4), async (cid) => { const v = await runEvaluation(cid); return { cid, total: v.totals.total, cost_usd: v.cost_usd }; });
    return { count: ids.length, ms: Date.now() - t0, cost_usd: Number(res.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(4)), results: res };
  },

  "GET /api/checklists": async () => sets().map((s) => ({ ...s, active_checklist: activeOf(s).checklist })),
  "POST /api/checklists": async (_, __, body) => {
    const errors = validateChecklist(body.checklist); if (errors.length) throw httpError(400, errors.join("; "));
    const st = sets(); const id = body.id || newId("cl");
    if (st.some((s) => s.id === id)) throw httpError(409, "id exists");
    for (const s of st) s.channels = s.channels.filter((c) => !(body.channels || []).includes(c));
    st.push({ id, name: body.name || body.checklist.name || "Новый чек-лист", channels: body.channels || [], active: 1, versions: [{ version: 1, created_at: new Date().toISOString(), note: body.note || "Создан", checklist: { ...body.checklist, id } }] });
    save("checklist_sets", st); return { id };
  },
  "POST /api/checklists/:id/versions": async ({ id }, __, body) => {
    const errors = validateChecklist(body.checklist); if (errors.length) throw httpError(400, errors.join("; "));
    const st = sets(); const s = st.find((x) => x.id === id); if (!s) throw httpError(404, "checklist not found");
    const version = Math.max(...s.versions.map((v) => v.version)) + 1;
    s.versions.push({ version, created_at: new Date().toISOString(), note: body.note || "", checklist: { ...body.checklist, id } });
    s.active = version; if (body.checklist.name) s.name = body.checklist.name;
    save("checklist_sets", st); return { version };
  },
  "POST /api/checklists/:id/activate": async ({ id }, __, body) => {
    const st = sets(); const s = st.find((x) => x.id === id); if (!s) throw httpError(404, "checklist not found");
    if (body.version) { if (!s.versions.some((v) => v.version === body.version)) throw httpError(404, "version not found"); s.active = body.version; }
    if (body.channels) { for (const o of st) if (o !== s) o.channels = o.channels.filter((c) => !body.channels.includes(c)); s.channels = body.channels; }
    save("checklist_sets", st); return { ok: true };
  },

  "GET /api/appeals": async (_, q) => {
    const evs = evals();
    return load("appeals", []).filter((a) => !q.status || a.status === q.status).map((a) => ({ ...a, conversation_id: evs.find((e) => e.id === a.evaluation_id)?.conversation_id })).reverse();
  },
  "POST /api/appeals": async (_, __, body) => {
    const ev = evals().find((e) => e.id === body.evaluation_id);
    if (!ev) throw httpError(404, "evaluation not found");
    const original = ev.results.find((r) => r.criterion_id === body.criterion_id);
    if (!original) throw httpError(400, "unknown criterion");
    if (!body.comment?.trim()) throw httpError(400, "comment is required");
    const all = load("appeals", []);
    if (all.some((a) => a.evaluation_id === ev.id && a.criterion_id === body.criterion_id && a.status === "open")) throw httpError(409, "appeal already open");
    const a = { id: newId("ap"), evaluation_id: ev.id, criterion_id: body.criterion_id, comment: body.comment.trim(), author: body.author || "Оператор", status: "open", created_at: new Date().toISOString(), original };
    all.push(a); save("appeals", all); return a;
  },
  "POST /api/appeals/:aid/decide": async ({ aid }, __, body) => {
    const all = load("appeals", []); const a = all.find((x) => x.id === aid);
    if (!a) throw httpError(404, "appeal not found");
    if (a.status !== "open") throw httpError(409, "appeal already decided");
    if (!body.reason?.trim()) throw httpError(400, "reason is required");
    let result;
    if (body.action === "uphold") a.status = "upheld";
    else if (body.action === "change") {
      a.status = "changed";
      result = { na: !!body.na, na_reason: body.na ? body.reason.trim() : "", ...(body.score !== undefined && !body.na ? { score: Number(body.score) } : {}), ...(body.answer && !body.na ? { answer: body.answer } : {}) };
    } else throw httpError(400, "action must be uphold or change");
    a.decision = { ...(result ? { result } : {}), reason: body.reason.trim(), reviewer: body.reviewer || "Проверяющий", decided_at: new Date().toISOString() };
    save("appeals", all);
    return { appeal: a, evaluation: view(evals().find((e) => e.id === a.evaluation_id)) };
  },

  // Team reference labels ("эталон") — used to measure accuracy before the control round.
  "GET /api/labels": async () => load("labels", {}),
  "POST /api/labels": async (_, __, body) => {
    if (!body.conversation_id || typeof body.results !== "object") throw httpError(400, "conversation_id and results are required");
    const all = load("labels", {});
    if (body.delete) delete all[body.conversation_id];
    else all[body.conversation_id] = { results: body.results, author: body.author || "", updated_at: new Date().toISOString() };
    save("labels", all); return { ok: true, count: Object.keys(all).length };
  },

  // Aggregates for the dashboard.
  "GET /api/stats": async (_, q) => {
    const all = evals(); const convs = Object.values(load("conversations", {})).filter((c) => !q.group || c.group_id === q.group);
    const vs = convs.map((c) => latestEval(c.conversation_id, all)).filter(Boolean).map((e) => view(e));
    const totals = vs.map((v) => v.totals.total).filter((t) => t !== null);
    const crit = {};
    for (const v of vs) for (const c of v.checklist.criteria) {
      const r = v.final_results.find((x) => x.criterion_id === c.id); if (!r) continue;
      const k = (crit[c.id] ||= { id: c.id, name: c.text, critical: c.critical_on === "yes", n: 0, na: 0, sum: 0, fails: 0 });
      k.n++; if (r.na) { k.na++; continue; }
      const norm = c.type === "scale" ? (r.score - c.scale.min) / (c.scale.max - c.scale.min) : r.answer === "yes" ? 1 : 0;
      k.sum += c.critical_on === "yes" ? 1 - norm : norm; if ((c.critical_on === "yes" ? 1 - norm : norm) < 1) k.fails++;
    }
    const by = (key) => Object.entries(vs.reduce((m, v) => { const c = convs.find((x) => x.conversation_id === v.conversation_id); const g = c[key]; (m[g] ||= []).push(v.totals.total); return m; }, {})).map(([k, arr]) => ({ key: k, n: arr.length, avg: avg(arr.filter((x) => x !== null)) }));
    // Language consistency: DEV has the same scenario in RU / KZ / EN (p1-ru-013 ≈ p1-kz-013 ≈ p1-en-013).
    // A model that understands all three languages must give the same verdicts across the set.
    const groupsByScenario = {};
    for (const v of vs) { const k = v.conversation_id.replace(/-(ru|kz|en)-/i, "-*-"); if (k !== v.conversation_id) (groupsByScenario[k] ||= []).push(v); }
    let agree = 0, compared = 0; const mismatches = [];
    for (const [k, arr] of Object.entries(groupsByScenario)) {
      if (arr.length < 2) continue;
      const diff = [];
      for (const c of arr[0].checklist.criteria) {
        const keys = arr.map((v) => { const r = v.final_results.find((x) => x.criterion_id === c.id); return !r ? "?" : r.na ? "N/A" : c.type === "scale" ? String(r.score) : r.answer; });
        compared++; if (new Set(keys).size === 1) agree++; else diff.push({ criterion: c.text, values: Object.fromEntries(arr.map((v, i) => [v.conversation_id, keys[i]])) });
      }
      if (diff.length) mismatches.push({ scenario: k, ids: arr.map((v) => v.conversation_id), diff });
    }
    // Accuracy vs team labels: model answers (before appeals) against the reference.
    const labels = load("labels", {});
    const acc = { dialogs: 0, criteria: {}, abs: 0, exact: 0, agree: 0, n: 0 };
    for (const v of vs) {
      const g = labels[v.conversation_id]; if (!g) continue;
      acc.dialogs++; let all = true;
      const goldResults = v.checklist.criteria.map((c) => toResult(c, g.results[c.id]));
      for (const c of v.checklist.criteria) {
        const want = g.results[c.id]; if (want === undefined || want === null || want === "") continue;
        const r = v.results.find((x) => x.criterion_id === c.id); const got = keyOf(c, r);
        const k = (acc.criteria[c.id] ||= { id: c.id, name: c.text, ok: 0, n: 0, misses: [] });
        k.n++; acc.n++; if (got === String(want)) { k.ok++; acc.agree++; } else { all = false; k.misses.push({ conversation_id: v.conversation_id, model: got, gold: String(want) }); }
      }
      const gt = computeTotals(v.checklist, goldResults).total, mt = v.original_totals.total;
      acc.abs += Math.abs((gt ?? 0) - (mt ?? 0)); if (all) acc.exact++;
    }
    const appeals = load("appeals", []);
    return {
      accuracy: acc.dialogs ? { dialogs: acc.dialogs, criterion_agreement: acc.agree / acc.n, exact_dialogs: acc.exact, mean_abs_total: Number((acc.abs / acc.dialogs).toFixed(2)), criteria: Object.values(acc.criteria).map((k) => ({ ...k, rate: k.ok / k.n })) } : null,
      language_consistency: compared ? { rate: agree / compared, scenarios: Object.values(groupsByScenario).filter((a) => a.length > 1).length, mismatches } : null,
      conversations: convs.length, evaluated: vs.length, avg_total: avg(totals),
      distribution: [0, 20, 40, 60, 80].map((lo) => ({ from: lo, to: lo + 20, n: totals.filter((t) => t >= lo && (lo === 80 ? t <= 100 : t < lo + 20)).length })),
      critical: vs.filter((v) => v.totals.critical_errors.length).map((v) => ({ conversation_id: v.conversation_id, total: v.totals.total, criteria: v.totals.critical_errors })),
      low_confidence: vs.filter((v) => v.low_confidence.length).map((v) => ({ conversation_id: v.conversation_id, criteria: v.low_confidence })),
      criteria: Object.values(crit).map((k) => ({ ...k, rate: k.n - k.na ? k.sum / (k.n - k.na) : null })),
      by_language: by("language"), by_channel: by("channel"),
      appeals: { open: appeals.filter((a) => a.status === "open").length, upheld: appeals.filter((a) => a.status === "upheld").length, changed: appeals.filter((a) => a.status === "changed").length },
      cost_usd: Number(vs.reduce((s, v) => s + (v.cost_usd || 0), 0).toFixed(4)), avg_ms: avg(vs.map((v) => v.ms)),
    };
  },
};

// CSV / JSON export of final results (one row per conversation × criterion).
async function exportResults(q, res) {
  const all = evals();
  const convs = Object.values(load("conversations", {})).filter((c) => !q.group || c.group_id === q.group);
  const rows = [];
  for (const c of convs) {
    const ev = latestEval(c.conversation_id, all); if (!ev) continue; const v = view(ev);
    for (const cr of v.checklist.criteria) {
      const r = v.final_results.find((x) => x.criterion_id === cr.id);
      rows.push({ conversation_id: c.conversation_id, group_id: c.group_id, channel: c.channel, language: c.language, checklist: `${ev.checklist_id}@v${ev.checklist_version}`, criterion_id: cr.id, criterion: cr.text,
        answer: r.na ? "N/A" : cr.type === "scale" ? r.score : r.answer === "yes" ? "Да" : "Нет", explanation: r.na ? r.na_reason : r.explanation, evidence: (r.evidence_ids || []).join(" "), overridden: !!r.overridden,
        total: v.totals.total, gross_error: v.totals.critical_errors.length ? "Да" : "Нет", model: ev.model });
    }
  }
  if (q.format === "json") { res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="cqa-${q.group || "all"}.json"` }); return res.end(JSON.stringify(rows, null, 2)); }
  const cols = Object.keys(rows[0] || { conversation_id: 1 });
  const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((k) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(","))].join("\r\n");
  res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="cqa-${q.group || "all"}.csv"` });
  res.end(csv);
}

// ---------- http ----------
const compiled = Object.entries(routes).map(([k, fn]) => {
  const [method, p] = k.split(" ");
  const keys = [];
  const re = new RegExp("^" + p.replace(/:(\w+)/g, (_, n) => (keys.push(n), "([^/]+)")) + "$");
  return { method, re, keys, fn };
});
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const keyOf = (c, r) => (!r ? "?" : r.na ? "na" : c.type === "scale" ? String(r.score) : r.answer);
const toResult = (c, v) => (v === "na" ? { criterion_id: c.id, na: true } : c.type === "scale" ? { criterion_id: c.id, score: Number(v) } : { criterion_id: c.id, answer: v });
const avg = (a) => (a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(2)) : null);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/export") return exportResults(Object.fromEntries(url.searchParams), res).catch((e) => send(res, 500, { error: e.message }));
  if (url.pathname.startsWith("/api/")) {
    const r = compiled.find((c) => c.method === req.method && c.re.test(url.pathname));
    if (!r) return send(res, 404, { error: "no route" });
    try {
      const m = url.pathname.match(r.re); const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (req.method === "POST") { let s = ""; for await (const ch of req) s += ch; body = s ? JSON.parse(s) : {}; }
      send(res, 200, await r.fn(params, Object.fromEntries(url.searchParams), body));
    } catch (e) { send(res, e.status || 500, { error: e.message }); }
    return;
  }
  const f = path.join(WEB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`CQA on http://localhost:${PORT}  (evaluator: ${process.env.LLM_API_KEY ? process.env.LLM_MODEL : "MOCK"})`));

function send(res, status, obj) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
