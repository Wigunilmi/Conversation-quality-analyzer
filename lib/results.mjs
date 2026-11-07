// Freedom Broker CQA results file, "Формат JSON 1.0" (appendix to the Student Guide).
// One record per dialog; value: true = Да, false = Нет, null = N/A, number = scale value before weighting;
// evidence_turns are 1-based over the whole transcript; final_score is our total (N/A weight redistributed);
// critical_flag mirrors the "critical" criterion and does not zero the total.
export const CODES = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"];
const CODE_BY_ID = { c01_contact: "contact", c02_need: "discovery", c03_identification: "identification", c04_consultation: "consultation", c05_empathy: "empathy", c06_management: "dialogue", c07_closing: "closure", c08_gross: "critical" };
const ALLOWED = { contact: [true, false], discovery: [true, false, null], identification: [true, false, null], consultation: [0, 5, 10, 15, 20, null], empathy: [true, false], dialogue: [0, 4, 7, 10], closure: [true, false, null], critical: [true, false] };

// The model cites lines 0-based as [n]; the file numbers turns from 1, so the text is shifted to match evidence_turns.
const renumber = (t) => t.replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (_, g) => `[${g.replace(/\d+/g, (n) => String(Number(n) + 1))}]`);

// items: [{ conversation, evaluation: View | null }]
export function buildResults(items, { team, mode = "external_api" } = {}) {
  const models = new Set();
  const results = [...items].sort((a, b) => a.conversation.conversation_id.localeCompare(b.conversation.conversation_id, "en", { numeric: true })).map(({ conversation: c, evaluation: v }) => {
    if (!v) return { conversation_id: c.conversation_id, status: "error", criteria: [], score: null, error: "Диалог не оценён: оценка не запускалась или модель не ответила." };
    if (v.model) models.add(v.model);
    const criteria = v.checklist.criteria.map((cr, i) => {
      const r = (v.final_results || v.results).find((x) => x.criterion_id === cr.id) || {};
      const value = r.na ? null : cr.type === "scale" ? Number(r.score) : r.answer === "yes";
      const turns = [...new Set((r.evidence_ids || []).map((n) => Number(n) + 1).filter((n) => n >= 1 && n <= c.transcript.length))].sort((a, b) => a - b);
      return { criterion_id: CODE_BY_ID[cr.id] || CODES[i] || cr.id, value, rationale: renumber(String((r.na ? r.na_reason || r.explanation : r.explanation || r.na_reason) || "").trim()), evidence_turns: turns };
    });
    const crit = criteria.find((x) => x.criterion_id === "critical");
    return { conversation_id: c.conversation_id, status: "ok", criteria, score: { final_score: v.totals.total, critical_flag: crit ? crit.value === true : (v.totals.critical_errors || []).length > 0 } };
  });
  return { schema_version: "1.0", team_name: team || process.env.TEAM_NAME || "BioC", model: { mode, name: [...models].join(", ") || "MOCK" }, results };
}

// Returns a list of problems (empty = file follows the format).
export function validateResults(doc, { expected } = {}) {
  const p = [];
  if (doc.schema_version !== "1.0") p.push("schema_version должен быть \"1.0\"");
  if (!doc.team_name) p.push("нет team_name");
  if (!["local", "external_api", "hybrid"].includes(doc.model?.mode) || !doc.model?.name) p.push("model.mode/name");
  const seen = new Set();
  for (const r of doc.results || []) {
    const id = r.conversation_id;
    if (seen.has(id)) p.push(`${id}: повторяющийся ID`); seen.add(id);
    if (r.status === "error") { if (r.criteria?.length || r.score !== null || !r.error) p.push(`${id}: неверная запись ошибки`); continue; }
    if (r.status !== "ok") { p.push(`${id}: status`); continue; }
    const codes = r.criteria.map((c) => c.criterion_id);
    if (codes.length !== 8 || CODES.some((c) => codes.filter((x) => x === c).length !== 1)) p.push(`${id}: нужны все 8 критериев ровно по одному разу (${codes.join(",")})`);
    for (const c of r.criteria) {
      if (ALLOWED[c.criterion_id] && !ALLOWED[c.criterion_id].includes(c.value)) p.push(`${id}/${c.criterion_id}: недопустимое value ${JSON.stringify(c.value)}`);
      if (!c.rationale) p.push(`${id}/${c.criterion_id}: пустой rationale`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((n) => !Number.isInteger(n) || n < 1)) p.push(`${id}/${c.criterion_id}: evidence_turns`);
    }
    const fs = r.score?.final_score;
    if (!(typeof fs === "number" && fs >= 0 && fs <= 100 && Math.abs(Math.round(fs * 100) - fs * 100) < 1e-6)) p.push(`${id}: final_score ${fs}`);
    const crit = r.criteria.find((c) => c.criterion_id === "critical");
    if (crit && r.score?.critical_flag !== crit.value) p.push(`${id}: critical_flag ≠ critical`);
  }
  if (expected != null && (doc.results || []).length !== expected) p.push(`записей ${(doc.results || []).length}, ожидалось ${expected}`);
  return p;
}
