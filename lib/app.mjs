// API router shared by the local server (server.mjs) and the Vercel function (api/index.mjs).
// Contract: API_CONTRACT.md. The FastAPI backend mirrors it.
import fs from "node:fs";
import { load, save, newId, backend, withRequestCache } from "./store.mjs";
import { evaluate } from "./evaluator.mjs";
import { detectLang } from "./facts.mjs";
import { computeTotals, validateChecklist } from "./scoring.mjs";

// ---------- data ----------
async function fetchGroup(groupId) {
  const base = process.env.CQA_API_URL;
  if (!base) throw httpError(500, "CQA_API_URL is not set (see .env.example)");
  const url = `${base}${base.includes("?") ? "&" : "?"}group_id=${encodeURIComponent(groupId)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j.isSuccess) throw httpError(502, `Organizers API: ${j.error || res.status}`);
  const convs = await load("conversations", {});
  for (const r of j.data.records) convs[r.conversation_id] = { ...r, group_id: groupId, loaded_at: new Date().toISOString() };
  await save("conversations", convs);
  return j.data.records.length;
}

// Checklist sets: one per kind (chat, call, custom…), each versioned and bound to channels.
async function sets() {
  let st = await load("checklist_sets", null);
  if (!st) {
    const seed = ["chat", "call"].map((f) => JSON.parse(fs.readFileSync(new URL(`../checklists/${f}.json`, import.meta.url), "utf8")));
    st = seed.map((cl) => ({ id: cl.id, name: cl.name, channels: cl.channels || [], active: 1, versions: [{ version: 1, created_at: new Date().toISOString(), note: "Исходная версия", checklist: cl }] }));
    await save("checklist_sets", st);
  }
  return st;
}
const activeOf = (s) => s.versions.find((v) => v.version === s.active);
const setFor = async (channel) => { const st = await sets(); return st.find((s) => s.channels.includes(channel)) || st[0]; };
const checklistAt = async (setId, version) => (await sets()).find((s) => s.id === setId)?.versions.find((v) => v.version === version)?.checklist;


// Final results = model results with decided appeals applied on top. Totals are recomputed on every read.
async function view(ev, { full = true } = {}) {
  const cl = await checklistAt(ev.checklist_id, ev.checklist_version);
  const appeals = (await load("appeals", [])).filter((a) => a.evaluation_id === ev.id);
  const final = ev.results.map((r) => {
    const a = appeals.find((x) => x.criterion_id === r.criterion_id && x.status === "changed");
    return a ? { ...r, ...a.decision.result, overridden: true, appeal_id: a.id } : r;
  });
  const out = { ...ev, appeals, final_results: final, original_totals: computeTotals(cl, ev.results), totals: computeTotals(cl, final), checklist: cl };
  if (!full) { delete out.trace; delete out.checklist; }
  return out;
}
const evals = () => load("evaluations", []);
const latestEval = (cid, all) => { for (let i = all.length - 1; i >= 0; i--) if (all[i].conversation_id === cid) return all[i]; };

// checklistId: the set the user picked; otherwise the set bound to the conversation's channel.
async function runEvaluation(cid, checklistId, opts = {}) {
  const conv = (await load("conversations", {}))[cid];
  if (!conv) throw httpError(404, `conversation ${cid} not loaded`);
  const s = checklistId ? (await sets()).find((x) => x.id === checklistId) : await setFor(conv.channel);
  if (!s) throw httpError(404, `checklist ${checklistId} not found`);
  const v = activeOf(s);
  const t0 = Date.now();
  const out = await evaluate(conv, v.checklist, [], opts);
  delete out.trace; // keep stored evaluations small
  const ev = { id: newId("ev"), conversation_id: cid, group_id: conv.group_id, checklist_id: s.id, checklist_name: s.name, checklist_version: v.version, created_at: new Date().toISOString(), ms: Date.now() - t0, ...out };
  Object.assign(ev, grossFlags(v.checklist, ev.results)); // gross-error flag stored in the DB, searchable by filter
  const all = await evals(); all.push(ev); await save("evaluations", all);
  return view(ev);
}

// Stored, filterable gross-error marks (Freedom: «грубая ошибка должна быть отмечена в базе данных»).
// Updated again when a reviewer changes the gross-error criterion on appeal.
function grossFlags(cl, results) {
  const t = computeTotals(cl, results);
  const why = t.critical_errors.map((id) => { const c = cl.criteria.find((x) => x.id === id); const r = results.find((x) => x.criterion_id === id); return { criterion_id: id, criterion: c?.text, explanation: r?.explanation || "", evidence_ids: r?.evidence_ids || [] }; });
  return { gross_error: why.length > 0, gross_errors: why };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, ...(await fn(items[k])) }; } catch (e) { out[k] = { ok: false, error: e.message }; } }
  }));
  return out;
}

async function listRows(group) {
  const all = await evals();
  return Promise.all(Object.values(await load("conversations", {})).filter((c) => !group || c.group_id === group).map(async (c) => {
    const ev = latestEval(c.conversation_id, all); const v = ev && (await view(ev, { full: false }));
    const cur = await setFor(c.channel);
    return {
      conversation_id: c.conversation_id, group_id: c.group_id, channel: c.channel, language: c.language, lines: c.transcript.length,
      total: v?.totals.total ?? null, original_total: v?.original_totals.total ?? null, critical: v?.totals.critical_errors || [], gross_error: ev ? (ev.gross_error ?? !!v.totals.critical_errors.length) : false,
      gross_reason: ev ? (ev.gross_errors || []).map((g) => g.explanation).join(" ") : "",
      checklist_id: ev?.checklist_id ?? null, checklist_version: ev?.checklist_version ?? null,
      outdated: !!ev && (ev.checklist_id !== cur.id || ev.checklist_version !== cur.active),
      appeals_open: v?.appeals.filter((a) => a.status === "open").length || 0, appeals_total: v?.appeals.length || 0,
      evaluated_at: ev?.created_at ?? null, model: ev?.model ?? null, cost_usd: ev?.cost_usd ?? null, ms: ev?.ms ?? null,
      preview: (c.transcript.find((t) => t.speaker === "client")?.text || "").slice(0, 120),
    };
  }));
}

// ---------- routes ----------
const routes = {
  // Diagnostics: which models the configured key can use (ids only, never the key).
  "GET /api/llm/models": async () => {
    if (!process.env.LLM_API_KEY) return { ok: false, error: "no LLM_API_KEY" };
    const r = await fetch(`${process.env.LLM_BASE_URL || "https://api.openai.com/v1"}/models`, { headers: { authorization: `Bearer ${process.env.LLM_API_KEY}` } });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
    return { ok: r.ok, status: r.status, configured: process.env.LLM_MODEL || null, base_url: process.env.LLM_BASE_URL || null, models: j?.data?.map((m) => m.id) || null, error: r.ok ? null : t.slice(0, 300) };
  },
  "GET /api/health": async () => ({ ok: true, store: backend, llm: process.env.LLM_API_KEY ? process.env.LLM_MODEL || "gpt-4.1-mini" : "MOCK", votes: Number(process.env.LLM_VOTES || 1) }),

  "POST /api/groups/:gid/load": async ({ gid }) => ({ loaded: await fetchGroup(gid) }),
  "GET /api/groups": async () => [...new Set(Object.values(await load("conversations", {})).map((c) => c.group_id))],

  "GET /api/conversations": async (_, q) => { const rows = await listRows(q.group); return q.gross === "1" ? rows.filter((r) => r.gross_error) : rows; },

  "GET /api/conversations/:cid": async ({ cid }) => {
    const conv = (await load("conversations", {}))[cid];
    if (!conv) throw httpError(404, "not found");
    const all = (await evals()).filter((e) => e.conversation_id === cid);
    const ev = all.at(-1);
    const history = await Promise.all(all.map(async (e) => ({ id: e.id, created_at: e.created_at, checklist_id: e.checklist_id, checklist_version: e.checklist_version, model: e.model, total: (await view(e, { full: false })).totals.total })));
    return { conversation: conv, evaluation: ev ? await view(ev) : null, history };
  },

  // The organizers' audio_url is an HTML player page; the real mp3 is a short-lived signed link inside it.
  "GET /api/conversations/:cid/audio": async ({ cid }) => {
    const conv = (await load("conversations", {}))[cid];
    if (!conv?.audio_url) throw httpError(404, "no audio");
    const html = await (await fetch(conv.audio_url)).text();
    const m = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/<audio[^>]+src="([^"]+)"/i);
    if (!m) throw httpError(502, "audio source not found");
    return { src: m[1].replace(/&amp;/g, "&"), page: conv.audio_url };
  },

  "POST /api/evaluate": async (_, __, body) => runEvaluation(body.conversation_id, body.checklist_id, { reasoning_effort: body.reasoning_effort }),

  // Manual upload of a transcript (Student Guide: «Загрузите транскрипт, выберите чек-лист и запустите оценку»).
  // Accepts one record, an array of records, or the organizers' full API response.
  "POST /api/conversations": async (_, __, body) => {
    const recs = body?.data?.records || (Array.isArray(body) ? body : body.records || [body]);
    const convs = await load("conversations", {}); const ids = [];
    for (const r of recs) {
      const tr = r.transcript;
      if (!Array.isArray(tr) || !tr.length) throw httpError(400, "transcript must be a non-empty array of {timestamp, speaker, text}");
      for (const [i, t] of tr.entries()) {
        if (!["client", "operator", "bot", "system"].includes(t.speaker)) throw httpError(400, `line ${i}: speaker must be client/operator/bot/system`);
        if (typeof t.text !== "string") throw httpError(400, `line ${i}: text is required`);
        t.timestamp = String(t.timestamp ?? "");
      }
      const id = r.conversation_id || newId("upload");
      const language = r.language || detectLang(tr.filter((t) => t.speaker === "client").map((t) => t.text).join(" ")) || "RU";
      convs[id] = { conversation_id: id, channel: r.channel === "voice call" ? "voice call" : "agent chat", language, transcript: tr, audio_url: r.audio_url || null, group_id: r.group_id || body.group_id || "UPLOAD", loaded_at: new Date().toISOString() };
      ids.push(id);
    }
    await save("conversations", convs); return { loaded: ids.length, ids };
  },

  "POST /api/evaluate-batch": async (_, __, body) => {
    const all = await evals(); const st = await sets();
    const ids = Object.values(await load("conversations", {}))
      .filter((c) => !body.group_id || c.group_id === body.group_id)
      .filter((c) => { if (!body.only_missing) return true; const ev = latestEval(c.conversation_id, all); const s = st.find((x) => x.channels.includes(c.channel)) || st[0]; return !ev || ev.checklist_id !== s.id || ev.checklist_version !== s.active; })
      .map((c) => c.conversation_id);
    const t0 = Date.now();
    const res = await pool(ids, Number(body.concurrency || process.env.LLM_CONCURRENCY || 4), async (cid) => { const v = await runEvaluation(cid, body.checklist_id, { reasoning_effort: body.reasoning_effort }); return { cid, total: v.totals.total, cost_usd: v.cost_usd }; });
    return { count: ids.length, ms: Date.now() - t0, cost_usd: Number(res.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(4)), results: res };
  },

  "GET /api/checklists": async () => (await sets()).map((s) => ({ ...s, active_checklist: activeOf(s).checklist })),
  "POST /api/checklists": async (_, __, body) => {
    const errors = validateChecklist(body.checklist); if (errors.length) throw httpError(400, errors.join("; "));
    const st = await sets(); const id = body.id || newId("cl");
    if (st.some((s) => s.id === id)) throw httpError(409, "id exists");
    for (const s of st) s.channels = s.channels.filter((c) => !(body.channels || []).includes(c));
    st.push({ id, name: body.name || body.checklist.name || "Новый чек-лист", channels: body.channels || [], active: 1, versions: [{ version: 1, created_at: new Date().toISOString(), note: body.note || "Создан", checklist: { ...body.checklist, id } }] });
    await save("checklist_sets", st); return { id };
  },
  "POST /api/checklists/:id/versions": async ({ id }, __, body) => {
    const errors = validateChecklist(body.checklist); if (errors.length) throw httpError(400, errors.join("; "));
    const st = await sets(); const s = st.find((x) => x.id === id); if (!s) throw httpError(404, "checklist not found");
    const version = Math.max(...s.versions.map((v) => v.version)) + 1;
    s.versions.push({ version, created_at: new Date().toISOString(), note: body.note || "", checklist: { ...body.checklist, id } });
    s.active = version; if (body.checklist.name) s.name = body.checklist.name;
    await save("checklist_sets", st); return { version };
  },
  "POST /api/checklists/:id/activate": async ({ id }, __, body) => {
    const st = await sets(); const s = st.find((x) => x.id === id); if (!s) throw httpError(404, "checklist not found");
    if (body.version) { if (!s.versions.some((v) => v.version === body.version)) throw httpError(404, "version not found"); s.active = body.version; }
    if (body.channels) { for (const o of st) if (o !== s) o.channels = o.channels.filter((c) => !body.channels.includes(c)); s.channels = body.channels; }
    await save("checklist_sets", st); return { ok: true };
  },

  "GET /api/appeals": async (_, q) => {
    const evs = await evals();
    return (await load("appeals", [])).filter((a) => !q.status || a.status === q.status).map((a) => ({ ...a, conversation_id: evs.find((e) => e.id === a.evaluation_id)?.conversation_id })).reverse();
  },
  "POST /api/appeals": async (_, __, body) => {
    const ev = (await evals()).find((e) => e.id === body.evaluation_id);
    if (!ev) throw httpError(404, "evaluation not found");
    const original = ev.results.find((r) => r.criterion_id === body.criterion_id);
    if (!original) throw httpError(400, "unknown criterion");
    if (!body.comment?.trim()) throw httpError(400, "comment is required");
    const all = await load("appeals", []);
    if (all.some((a) => a.evaluation_id === ev.id && a.criterion_id === body.criterion_id && a.status === "open")) throw httpError(409, "appeal already open");
    const a = { id: newId("ap"), evaluation_id: ev.id, criterion_id: body.criterion_id, comment: body.comment.trim(), author: body.author || "Оператор", status: "open", created_at: new Date().toISOString(), original };
    all.push(a); await save("appeals", all); return a;
  },
  "POST /api/appeals/:aid/decide": async ({ aid }, __, body) => {
    const all = await load("appeals", []); const a = all.find((x) => x.id === aid);
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
    await save("appeals", all);
    const evsAll = await evals(); const evDoc = evsAll.find((e) => e.id === a.evaluation_id);
    const v = await view(evDoc);
    Object.assign(evDoc, grossFlags(v.checklist, v.final_results)); await save("evaluations", evsAll); // keep the stored flag in sync
    return { appeal: a, evaluation: await view(evDoc) };
  },

};

// ---------- dispatch ----------
const compiled = Object.entries(routes).map(([k, fn]) => {
  const [method, p] = k.split(" ");
  const keys = [];
  const re = new RegExp("^" + p.replace(/:(\w+)/g, (_, n) => (keys.push(n), "([^/]+)")) + "$");
  return { method, re, keys, fn };
});
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Node-style (req, res) handler for /api/* — works in http.createServer and in Vercel functions.
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://x");
  // On Vercel the rewrite may surface as /api/index; the original path is then in x-matched-path / x-forwarded-uri / x-original-url.
  if (url.pathname === "/api/index") { const orig = req.headers["x-forwarded-uri"] || req.headers["x-original-url"] || req.headers["x-invoke-path"]; if (orig) { const o = new URL(orig, "http://x"); url.pathname = o.pathname; o.searchParams.forEach((v, k) => url.searchParams.set(k, v)); } }
  const r = compiled.find((c) => c.method === req.method && c.re.test(url.pathname));
  if (!r) return send(res, 404, { error: "no route" });
  try {
    const m = url.pathname.match(r.re); const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let body = req.body && typeof req.body === "object" ? req.body : {};
    if (req.method === "POST" && !req.body) { let s = ""; for await (const ch of req) s += ch; body = s ? JSON.parse(s) : {}; }
    else if (typeof req.body === "string") body = req.body ? JSON.parse(req.body) : {};
    send(res, 200, await withRequestCache(() => r.fn(params, Object.fromEntries(url.searchParams), body)));
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}
function send(res, status, obj) { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); }
