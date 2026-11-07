import { api, esc, toast, verdict, fmt, ago, channelIcon } from "../lib/api.js";
import { refreshBadges } from "../app.js";

let status = "open";

export async function render(root) {
  const items = await api(`/api/appeals${status ? `?status=${status}` : ""}`);
  root.innerHTML = `
  <div class="page">
    <div class="page-head"><h1>Апелляции</h1><span class="sub">Рабочее место проверяющего</span><span class="spacer"></span>
      <div class="seg" id="st">${[["open", "На рассмотрении"], ["changed", "Изменены"], ["upheld", "Подтверждены"], ["", "Все"]].map(([v, l]) => `<button data-v="${v}" class="${v === status ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="stack" id="items">${items.length ? "" : `<div class="card empty"><b>${status === "open" ? "Очередь пуста" : "Ничего не найдено"}</b>Апелляцию подают из карточки диалога кнопкой «Оспорить» у критерия.</div>`}</div>
  </div>`;
  root.querySelector("#st").onclick = (e) => { const b = e.target.closest("button"); if (b) { status = b.dataset.v; render(root); } };
  const box = root.querySelector("#items");
  const cards = await Promise.all(items.map((a) => card(a, root)));
  cards.forEach((c) => box.append(c));
}

async function card(a, root) {
  const { conversation: conv, evaluation: ev } = await api(`/api/conversations/${encodeURIComponent(a.conversation_id)}`);
  const c = ev.checklist.criteria.find((x) => x.id === a.criterion_id) || { text: a.criterion_id, type: "binary" };
  const ids = a.original.evidence_ids || [];
  const ctx = [...new Set(ids.flatMap((i) => [i - 1, i, i + 1]).filter((i) => i >= 0 && i < conv.transcript.length))].sort((x, y) => x - y);
  const ov = verdict(c, a.original);
  const el = document.createElement("div");
  el.className = "card ap";
  el.innerHTML = `
    <div class="toolbar" style="margin:0">
      <a class="mono" href="#/c/${encodeURIComponent(a.conversation_id)}">${channelIcon(conv.channel)} ${esc(a.conversation_id)}</a>
      <b>${esc(c.text)}</b>
      <span class="pill ${a.status === "open" ? "mid" : a.status === "changed" ? "info" : "good"}">${{ open: "на рассмотрении", changed: "изменена", upheld: "подтверждена" }[a.status]}</span>
      <span class="spacer"></span><span class="muted small">${esc(a.author)} · ${ago(a.created_at)}</span>
    </div>
    <div class="ap-cols">
      <div><div class="muted small">ИСХОДНАЯ ОЦЕНКА МОДЕЛИ</div><div style="margin:4px 0"><span class="pill ${ov.cls === "yes" ? "good" : ov.cls === "no" ? "bad" : ov.cls === "part" ? "mid" : ""}">${ov.label}</span></div><div class="small ink2">${esc(a.original.na ? a.original.na_reason : a.original.explanation)}</div></div>
      <div><div class="muted small">КОММЕНТАРИЙ АПЕЛЛЯЦИИ</div><div style="margin-top:4px">«${esc(a.comment)}»</div></div>
      <div><div class="muted small">РЕШЕНИЕ</div>${a.status === "open" ? decisionForm(c) : `<div style="margin:4px 0"><b>${a.status === "upheld" ? "Оценка подтверждена" : "Изменено на: " + verdict(c, a.decision.result).label}</b></div><div class="small ink2">${esc(a.decision.reason)}</div><div class="small muted">${esc(a.decision.reviewer)} · ${ago(a.decision.decided_at)}</div>`}</div>
    </div>
    <div class="snippet">${ctx.map((i) => { const t = conv.transcript[i]; return `<div class="small" style="${ids.includes(i) ? "background:var(--hl);border-radius:6px;padding:2px 6px" : "padding:2px 6px"}"><span class="mono muted">#${i}</span> <b>${esc(t.speaker)}</b>: ${esc(t.text)}</div>`; }).join("") || '<span class="muted small">Модель не указала реплику — откройте диалог целиком.</span>'}</div>
    <div class="small muted">Итог диалога сейчас: <b>${ev.totals.total === null ? "N/A" : fmt(ev.totals.total)}</b>${ev.original_totals.total !== ev.totals.total ? ` (исходный ${fmt(ev.original_totals.total)})` : ""}</div>`;

  const f = el.querySelector("form");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter.value;
    const body = { action, reason: f.elements.reason.value };
    if (action === "change") {
      if (f.elements.na?.checked) body.na = true;
      else if (c.type === "scale") body.score = Number(f.elements.score.value);
      else body.answer = f.elements.answer.value;
    }
    try { const r = await api(`/api/appeals/${a.id}/decide`, body); toast(`Решение сохранено. Итог диалога: ${r.evaluation.totals.total === null ? "N/A" : fmt(r.evaluation.totals.total)}`); refreshBadges(); render(root); }
    catch (err) { toast(err.message, true); }
  };
  return el;
}

function decisionForm(c) {
  const input = c.type === "scale"
    ? (c.scale.steps?.length ? `<select class="input" name="score">${c.scale.steps.map((x) => `<option value="${x.value}">${x.value} — ${esc(x.label)}</option>`).join("")}</select>` : `<input class="input" name="score" type="number" min="${c.scale.min}" max="${c.scale.max}" value="${c.scale.max}" />`)
    : c.critical_on === "yes" ? `<select class="input" name="answer"><option value="no">Нарушений нет</option><option value="yes">Нарушение есть</option></select>`
    : `<select class="input" name="answer"><option value="yes">Да</option><option value="no">Нет</option></select>`;
  return `<form class="stack" style="gap:8px;margin-top:6px">
    <label class="small muted">Новая оценка ${input}</label>
    ${c.na_allowed ? '<label class="chk small"><input type="checkbox" name="na" /> N/A</label>' : ""}
    <textarea class="input" name="reason" rows="2" required placeholder="Причина решения"></textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" name="action" value="uphold">Подтвердить исходную</button><button class="btn primary" name="action" value="change">Изменить оценку</button></div>
  </form>`;
}
