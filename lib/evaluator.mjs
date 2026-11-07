// Evaluates one conversation against one checklist.
//
// Pipeline (hybrid, every step visible in the UI under "Как модель решила"):
//   1. facts.mjs  — code extracts deterministic facts (who greeted, delays, system events, language)
//   2. LLM judge  — any OpenAI-compatible API; strict JSON; the facts are given as hints
//   3. sanitize   — N/A only where allowed, evidence ids must exist, scale snapped to allowed steps; 1 repair retry
//   4. voting     — LLM_VOTES=N runs N judges in parallel; majority per criterion, agreement = confidence
//   5. scoring.mjs computes every number (never the model)
// MOCK mode (no LLM_API_KEY): deterministic heuristics from the same facts, for offline UI work.

import fs from "node:fs";
import { extractFacts, factsText } from "./facts.mjs";

const KEY = () => process.env.LLM_API_KEY;
// Prompt texts live in /prompts so the JS reference and the Python backend use the same words.
const P = (f) => fs.readFileSync(new URL(`../prompts/${f}`, import.meta.url), "utf8");
const PROMPT = { system: P("judge_system.md"), call: P("call_rules.md"), guidance: P("guidance.md") };
const PROMPT_VERSION = "2026-11-07.5";

export function numbered(transcript) {
  return transcript.map((t, i) => `[${i}] ${t.timestamp} ${String(t.speaker).toUpperCase()}: ${t.text}`).join("\n");
}

// Few-shot calibration: team reference labels of OTHER dialogs (never the dialog being scored).
export function examplesText(examples = []) {
  if (!examples.length) return "";
  return "ПРИМЕРЫ ЭТАЛОННОЙ РАЗМЕТКИ (команда QA, другие диалоги):\n" + examples.map((e, k) => {
    const tr = e.conv.transcript.length > 40 ? [...e.conv.transcript.slice(0, 40), { timestamp: "…", speaker: "system", text: `(ещё ${e.conv.transcript.length - 40} реплик)` }] : e.conv.transcript;
    return `--- Пример ${k + 1} (${e.conv.channel}, ${e.conv.language}) ---\n${numbered(tr)}\nЭталон: ${JSON.stringify(e.gold)}`;
  }).join("\n\n") + "\n\n";
}

export function buildPrompt(conv, checklist, facts = extractFacts(conv), examples = []) {
  const crit = checklist.criteria.map((c) => ({
    id: c.id, name: c.text, rule_yes: c.description || undefined, type: c.type,
    allowed_scores: c.type === "scale" ? (c.scale.steps?.length ? c.scale.steps : `integer ${c.scale.min}..${c.scale.max}`) : undefined,
    na_allowed: !!c.na_allowed, na_condition: c.na_allowed ? c.na_rule || undefined : undefined,
    yes_means_violation: c.critical_on === "yes" ? true : undefined,
  }));
  const isCall = conv.channel === "voice call";
  const system = PROMPT.system
    .replace("{{CALL_RULES}}", isCall ? PROMPT.call : "")
    .replace("{{GUIDANCE}}", checklist.instructions ? PROMPT.guidance.replace("{{INSTRUCTIONS}}", checklist.instructions) : "");
  const user = `${examplesText(examples)}ЧЕК-ЛИСТ:\n${JSON.stringify(crit, null, 1)}\n\nФАКТЫ:\n${factsText(facts)}\n\nДИАЛОГ (${conv.channel}, ${conv.language}):\n${numbered(conv.transcript)}`;
  return { system, user };
}

// Fix up what the model returned: unknown evidence ids, out-of-range scores, N/A where not allowed.
export function sanitize(conv, checklist, raw) {
  const n = conv.transcript.length;
  const byId = Object.fromEntries((raw?.results || []).map((r) => [r.criterion_id, r]));
  const problems = [];
  const results = checklist.criteria.map((c) => {
    const r = byId[c.id] || {};
    if (!byId[c.id]) problems.push(`${c.id}: missing`);
    const na = !!r.na && !!c.na_allowed;
    if (r.na && !c.na_allowed) problems.push(`${c.id}: N/A not allowed`);
    const evidence = [...new Set((r.evidence_ids || []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    if ((r.evidence_ids || []).length !== evidence.length) problems.push(`${c.id}: bad evidence ids`);
    const conf = Number(r.confidence);
    const out = { criterion_id: c.id, na, na_reason: na ? r.na_reason || "" : "", explanation: r.explanation || "", evidence_ids: evidence, checked_span: r.checked_span || "", confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null };
    if (!na) {
      if (c.type === "scale") {
        out.score = snap(c, Number(r.score));
        if (out.score !== Number(r.score)) problems.push(`${c.id}: score ${r.score} is not an allowed step`);
      } else out.answer = r.answer === "yes" ? "yes" : "no";
    }
    return out;
  });
  return { results, problems };
}

// Nearest allowed step (or clamp to the integer range when the scale has no steps).
export function snap(c, x) {
  const { min, max, steps } = c.scale;
  if (!Number.isFinite(x)) return min;
  if (steps?.length) return steps.map((s) => s.value).reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
  return Math.min(max, Math.max(min, Math.round(x)));
}

// Majority vote across N sanitized runs. Agreement share becomes the confidence.
export function vote(checklist, runs) {
  if (runs.length === 1) return runs[0];
  return checklist.criteria.map((c) => {
    const rs = runs.map((r) => r.find((x) => x.criterion_id === c.id));
    const key = (r) => (r.na ? "na" : c.type === "scale" ? `s${r.score}` : r.answer);
    const counts = new Map(); rs.forEach((r) => counts.set(key(r), (counts.get(key(r)) || 0) + 1));
    let best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    // Scale with no majority → median step.
    if (c.type === "scale" && best[1] * 2 <= rs.length && rs.every((r) => !r.na)) {
      const med = rs.map((r) => r.score).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
      best = [`s${med}`, rs.filter((r) => r.score === med).length];
    }
    const pick = rs.find((r) => key(r) === best[0]);
    return { ...pick, confidence: Number((best[1] / rs.length).toFixed(2)), votes: rs.map(key) };
  });
}

async function callLLM(prompt, attempt = 0) {
  try { return await callOnce(prompt); }
  catch (e) {
    if (attempt >= 5 || !/LLM (429|5\d\d)|model_not_found|fetch failed|JSON/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** attempt)));
    return callLLM(prompt, attempt + 1);
  }
}

// Some providers (e.g. Meta Model API) may not accept response_format; we then drop it and rely on the prompt.
let jsonMode = process.env.LLM_JSON_MODE !== "0";
// Reasoning depth (Meta Muse Spark: minimal|low|medium|high|xhigh). Thinking tokens are most of the latency,
// and this task is classification with a strict JSON answer, so "low" is the default for reasoning models.
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const defaultEffort = () => process.env.LLM_REASONING_EFFORT ?? (/^muse-spark/.test(process.env.LLM_MODEL || "") ? "low" : "");
let effortSupported = true;
async function callOnce({ system, user, effort }) {
  const send = () => fetch(`${process.env.LLM_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(effort && effortSupported ? { reasoning_effort: effort } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  let res = await send();
  // Some Meta deployments answer an unsupported reasoning_effort with 400 or with 404 model_not_found:
  // retry this call without it, and stop sending it if that works.
  if ((res.status === 400 || res.status === 404) && effort && effortSupported) {
    const t = await res.clone().text();
    if (/reasoning|model_not_found/i.test(t)) { effortSupported = false; res = await send(); if (!res.ok) effortSupported = true; }
  }
  if (res.status === 400 && jsonMode) { const t = await res.text(); if (/response_format|json/i.test(t)) { jsonMode = false; res = await send(); } else throw new Error(`LLM 400: ${t.slice(0, 300)}`); }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  let json;
  try { json = JSON.parse(extractJson(text)); } catch { throw new Error("LLM returned invalid JSON"); }
  return { json, text, usage: j.usage || {} };
}

// Tolerates ```json fences and text around the object (models without JSON mode).
export function extractJson(text) {
  const t = text.replace(/```(json)?/gi, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

async function oneRun(conv, checklist, prompt) {
  let { json, text, usage } = await callLLM(prompt);
  let { results, problems } = sanitize(conv, checklist, json);
  const repaired = problems.length > 0;
  if (repaired) {
    const retry = await callLLM({ ...prompt, user: `${prompt.user}\n\nВ прошлом ответе были ошибки: ${problems.join("; ")}. Верни полный исправленный JSON.` });
    usage = { prompt_tokens: (usage.prompt_tokens || 0) + (retry.usage.prompt_tokens || 0), completion_tokens: (usage.completion_tokens || 0) + (retry.usage.completion_tokens || 0) };
    text = retry.text;
    ({ results, problems } = sanitize(conv, checklist, retry.json));
  }
  return { results, problems, usage, raw: text, repaired };
}

export async function evaluate(conv, checklist, examples = [], opts = {}) {
  const facts = extractFacts(conv);
  if (!KEY()) return { ...mock(conv, checklist, facts), facts, model: "MOCK (без ключа модели)", cost_usd: 0, prompt_version: PROMPT_VERSION };
  const effort = EFFORTS.includes(opts.reasoning_effort) ? opts.reasoning_effort : defaultEffort();
  const prompt = { ...buildPrompt(conv, checklist, facts, examples), effort };
  const n = Math.max(1, Number(process.env.LLM_VOTES || 1));
  const runs = await Promise.all(Array.from({ length: n }, () => oneRun(conv, checklist, prompt)));
  const usage = runs.reduce((u, r) => ({ prompt_tokens: u.prompt_tokens + (r.usage.prompt_tokens || 0), completion_tokens: u.completion_tokens + (r.usage.completion_tokens || 0) }), { prompt_tokens: 0, completion_tokens: 0 });
  const cost = (usage.prompt_tokens * Number(process.env.LLM_PRICE_IN || 0) + usage.completion_tokens * Number(process.env.LLM_PRICE_OUT || 0)) / 1e6;
  return {
    results: vote(checklist, runs.map((r) => r.results)),
    problems: runs.flatMap((r) => r.problems),
    facts, model: process.env.LLM_MODEL || "gpt-4.1-mini", reasoning_effort: effort && effortSupported ? effort : null, votes: n, usage, cost_usd: Number(cost.toFixed(5)),
    prompt_version: PROMPT_VERSION, examples: examples.map((e) => e.conv.conversation_id),
    trace: { system: prompt.system, user: prompt.user, raw: runs.map((r) => r.raw), repaired: runs.some((r) => r.repaired) },
  };
}

// ---------- MOCK: same facts, simple rules ----------
function mock(conv, checklist, f) {
  const ops = conv.transcript.map((t, i) => ({ ...t, i })).filter((t) => t.speaker === "operator");
  const span = ops.length ? `${ops[0].i}-${ops.at(-1).i}` : "";
  const results = checklist.criteria.map((c) => {
    const base = { criterion_id: c.id, na: false, na_reason: "", evidence_ids: [], checked_span: "", explanation: "", confidence: null };
    if (!ops.length) return c.na_allowed ? { ...base, na: true, na_reason: "Оператор не подключался к диалогу." } : { ...base, ...pass(c, false), checked_span: `0-${conv.transcript.length - 1}`, explanation: "Реплик оператора нет." };
    if (/contact|greeting/.test(c.id)) {
      const ok = f.first_reply_has_greeting && f.first_reply_has_introduction && (!f.client_language || f.first_reply_language === f.client_language);
      return { ...base, ...pass(c, ok), evidence_ids: [f.first_operator_idx], explanation: ok ? "Оператор поздоровался на языке клиента и представился в первом ответе." : "В первом ответе нет приветствия, имени или он не на языке клиента." };
    }
    if (/identification/.test(c.id)) {
      return f.events.identity_verified >= 0 ? { ...base, answer: "yes", evidence_ids: [f.events.identity_verified], explanation: "Есть системное подтверждение личности." }
        : { ...base, na: true, na_reason: "MOCK: проверка личности не требовалась (нет защищённого действия)." };
    }
    if (/closing/.test(c.id)) {
      if (f.ended_by === "connection_lost") return { ...base, na: true, na_reason: "Связь оборвалась до завершения." };
      const ok = f.farewell_idx !== null;
      return { ...base, ...pass(c, ok), evidence_ids: ok ? [f.farewell_idx] : [f.last_operator_idx], checked_span: ok ? "" : span, explanation: ok ? "Оператор попрощался." : "Прощания не найдено." };
    }
    if (/management/.test(c.id) && f.long_waits.some((w) => !w.warned)) return { ...base, score: 7, evidence_ids: [f.long_waits[0].to], explanation: "Пауза более 3 минут без предупреждения." };
    if (c.critical_on === "yes") return f.gross_hints.length ? { ...base, answer: "yes", evidence_ids: [...new Set(f.gross_hints.map((h) => h.idx))], explanation: `Найдено: ${[...new Set(f.gross_hints.map((h) => h.kind))].join(", ")} — реплика оператора #${f.gross_hints[0].idx}: «${conv.transcript[f.gross_hints[0].idx].text.slice(0, 160)}».` } : { ...base, answer: "no", checked_span: span, explanation: "MOCK: нарушений не найдено." };
    if (c.na_allowed) return { ...base, na: true, na_reason: "MOCK: условие N/A (заглушка до подключения модели)." };
    return { ...base, ...pass(c, true), evidence_ids: [ops.at(-1).i], explanation: "MOCK: оценка-заглушка, подключите LLM_API_KEY." };
  });
  return { results, problems: [] };
}
const pass = (c, ok) => (c.type === "scale" ? { score: ok ? c.scale.max : c.scale.min } : { answer: ok ? "yes" : "no" });
