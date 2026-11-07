import { api, esc, toast, verdict, offsetSec, mmss, timeLabel, ring, fmt, LANG, channelIcon, ago } from "../lib/api.js";
import { refreshBadges } from "../app.js";
import { speak, stopSpeaking, ttsSupported, prefs } from "../lib/prefs.js";

const SPEAKER = { operator: "Оператор", client: "Клиент", bot: "Бот", system: "Система" };
let tab = "criteria", lastCid = null;
let keyHandler;

export function unmount() { removeEventListener("keydown", keyHandler); }

export async function render(root, [cid]) {
  if (cid !== lastCid) { tab = "criteria"; lastCid = cid; }
  const [{ conversation: conv, evaluation: ev, history }, sets] = await Promise.all([api(`/api/conversations/${encodeURIComponent(cid)}`), api("/api/checklists")]);
  const isCall = conv.channel === "voice call";
  const base = ev?.facts?.audio_offset_base_idx ?? 0;
  const order = JSON.parse(sessionStorage.getItem("cqa-order") || "[]");
  const pos = order.indexOf(cid);
  const prev = pos > 0 ? order[pos - 1] : null, next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;

  root.innerHTML = `
  <div class="page">
    <div class="page-head">
      <a class="btn ghost" href="#/list">← Диалоги</a>
      <h1 class="mono" style="font-size:20px">${esc(conv.conversation_id)}</h1>
      <span class="pill">${channelIcon(conv.channel)} ${isCall ? "Звонок" : "Чат"}</span><span class="pill">${LANG[conv.language] || esc(conv.language)}</span>
      ${ev ? `<span class="pill info" title="Чек-лист, по которому сделана оценка">${esc(ev.checklist_name || ev.checklist_id)} · v${ev.checklist_version}</span>` : ""}
      <span class="spacer"></span>
      <a class="btn ghost ${prev ? "" : "hidden"}" href="#/c/${encodeURIComponent(prev || "")}" title="Предыдущий (←)">‹</a>
      <span class="muted small">${pos >= 0 ? `${pos + 1} / ${order.length}` : ""}</span>
      <a class="btn ghost ${next ? "" : "hidden"}" href="#/c/${encodeURIComponent(next || "")}" title="Следующий (→)">›</a>
      <select class="input" id="cl" title="Чек-лист для оценки" style="max-width:300px"><option value="">Чек-лист: по каналу</option>${sets.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · v${x.active}</option>`).join("")}</select>
      ${ev && ttsSupported() ? '<button class="btn speak" id="speak" aria-pressed="false" title="Прочитать оценку вслух">🔊 Озвучить</button>' : ""}
      <button class="btn primary" id="eval">${ev ? "↻ Переоценить" : "▶ Оценить"}</button>
    </div>
    <div class="dlg">
      <div class="card convo">
        ${isCall ? `<div class="convo-head"><div class="audio"><audio id="audio" controls preload="none"></audio><a class="btn ghost small" target="_blank" rel="noopener" href="${esc(conv.audio_url)}" title="Открыть страницу записи">↗</a></div>
          <div class="muted small" id="audio-msg">Нажмите на время реплики, чтобы прослушать этот фрагмент.</div></div>` : ""}
        <div class="convo-body" id="tr">${conv.transcript.map((t, i) => `
          <div class="msg ${esc(t.speaker)}" id="m${i}" data-i="${i}">
            <div class="meta">${t.speaker !== "system" ? `<b>${SPEAKER[t.speaker] || esc(t.speaker)}</b>` : ""}
              <span class="${isCall ? "ts-play" : ""}" data-play="${i}" title="${isCall ? "Прослушать с этого места" : ""}">${isCall ? "▶ " + mmss(offsetSec(conv.transcript, i, base)) : esc(timeLabel(t.timestamp))}</span><span class="ix">#${i}</span></div>
            <div class="bubble">${esc(t.text)}</div>
          </div>`).join("")}
        </div>
      </div>
      <div class="result" id="res">${ev ? resultHtml(ev, conv, history) : `<div class="card empty"><b>Диалог ещё не оценён</b>Нажмите «Оценить» — модель проверит его по чек-листу «${isCall ? "звонки" : "чаты"}».</div>`}</div>
    </div>
  </div>`;

  const q = (s) => root.querySelector(s);
  const sp = q("#speak");
  if (sp) sp.onclick = () => {
    if (sp.classList.contains("on")) { stopSpeaking(); sp.classList.remove("on"); sp.setAttribute("aria-pressed", "false"); sp.textContent = "🔊 Озвучить"; return; }
    const done = () => { sp.classList.remove("on"); sp.setAttribute("aria-pressed", "false"); sp.textContent = "🔊 Озвучить"; };
    sp.classList.add("on"); sp.setAttribute("aria-pressed", "true"); sp.textContent = "⏹ Остановить";
    speak(speechParts(ev, conv), "RU", done);
  };
  if (sp && prefs().autospeak) sp.click(); // «Незрячим»: read the evaluation as soon as the dialog opens
  q("#eval").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Оцениваю…";
    try { await api("/api/evaluate", { conversation_id: cid, checklist_id: q("#cl").value || undefined }); toast("Оценка обновлена"); } catch (err) { toast(err.message, true); }
    render(root, [cid]);
  };

  // Audio: the backend resolves the short-lived mp3 link only when the user wants to listen.
  let audioReady = null;
  const audio = q("#audio");
  const ensureAudio = () => audioReady ||= api(`/api/conversations/${encodeURIComponent(cid)}/audio`).then((a) => { audio.src = a.src; return new Promise((ok) => { audio.addEventListener("loadedmetadata", ok, { once: true }); audio.load(); }); }).catch((e) => { q("#audio-msg").textContent = `Запись недоступна: ${e.message}`; audioReady = null; throw e; });
  const seek = async (i) => {
    if (!audio) return;
    try { await ensureAudio(); audio.currentTime = offsetSec(conv.transcript, i, base); await audio.play(); } catch {}
  };
  if (audio) {
    audio.addEventListener("play", () => ensureAudio(), { once: true });
    audio.addEventListener("timeupdate", () => {
      const t = audio.currentTime; let cur = -1;
      conv.transcript.forEach((_, i) => { if (offsetSec(conv.transcript, i, base) <= t) cur = i; });
      root.querySelectorAll(".msg.playing").forEach((n) => n.classList.remove("playing"));
      root.querySelector(`#m${cur}`)?.classList.add("playing");
    });
  }
  q("#tr").onclick = (e) => { const p = e.target.closest("[data-play]"); if (p && isCall) seek(Number(p.dataset.play)); };

  const res = q("#res");
  res.onclick = async (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; res.innerHTML = resultHtml(ev, conv, history); return; }
    const evi = e.target.closest("[data-ev]"); if (evi) { const ids = evi.dataset.ev.split(",").map(Number); focusLines(root, ids, "hit"); if (isCall && evi.dataset.play !== undefined) seek(ids[0]); return; }
    const sp = e.target.closest("[data-span]"); if (sp) { const [a, b = a] = sp.dataset.span.split(/[-–]/).map(Number); if (Number.isFinite(a)) focusLines(root, range(a, Math.min(b, conv.transcript.length - 1)), "span"); return; }
    const ap = e.target.closest("[data-appeal]"); if (ap) return openAppeal(ap.closest(".crit"), ap.dataset.appeal, ev, root, cid);
  };

  keyHandler = (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.key === "ArrowLeft" && prev) location.hash = `#/c/${encodeURIComponent(prev)}`;
    if (e.key === "ArrowRight" && next) location.hash = `#/c/${encodeURIComponent(next)}`;
  };
  addEventListener("keydown", keyHandler);
}

function resultHtml(ev, conv, history) {
  const t = ev.totals, o = ev.original_totals;
  const changed = t.total !== o.total;
  const secs = Object.entries(t.sections).filter(([n]) => !/груб/i.test(n));
  return `
  <div class="card summary">
    ${ring(t.total, t.max_score)}
    <div class="secbars">
      ${changed ? `<div class="small">После апелляции: <s class="muted">${fmt(o.total)}</s> → <b>${fmt(t.total)}</b></div>` : ""}
      ${secs.map(([n, v]) => `<div class="secbar"><span class="ink2">${esc(n)}</span><b style="text-align:right">${v === null ? "N/A" : fmt(v, 0)}</b><div class="progress"><i style="width:${v ?? 0}%"></i></div></div>`).join("")}
      <div class="muted small">Модель: ${esc(ev.model)} · стоимость оценки $${fmt(ev.cost_usd || 0, 4)} · ${fmt(ev.ms / 1000, 1)} с · ${ago(ev.created_at)}</div>
    </div>
  </div>
  ${t.critical_errors.length ? `<div class="banner bad"><b>⚠</b><div><b>Обнаружена грубая ошибка.</b> ${t.critical_errors.map((id) => { const r = ev.final_results.find((x) => x.criterion_id === id); return `${esc(r?.explanation || "")} ${(r?.evidence_ids || []).length ? `<span class="chip" data-ev="${r.evidence_ids.join(",")}">↳ ${r.evidence_ids.map((i) => "#" + i).join(" ")}</span>` : ""}`; }).join(" ")}<div class="small">Отмечается отдельно от балла и сохраняется в базе — диалог находится фильтром «⚠ Грубые ошибки».</div></div></div>` : ""}
  ${t.total === null ? `<div class="banner info"><b>i</b><div>Все критерии с весом получили N/A — по правилам чек-листа итог не рассчитывается.</div></div>` : ""}
  <div class="card">
    <div class="tabs">${[["criteria", "Критерии"], ["history", `Апелляции и история${ev.appeals.length ? ` (${ev.appeals.length})` : ""}`]].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
    ${tab === "history" ? historyHtml(ev, history) : criteriaHtml(ev, conv)}
  </div>`;
}

function criteriaHtml(ev, conv) {
  const isCall = conv.channel === "voice call";
  return ev.checklist.criteria.map((c) => {
    const r = ev.final_results.find((x) => x.criterion_id === c.id) || {};
    const orig = ev.results.find((x) => x.criterion_id === c.id);
    const row = ev.totals.rows.find((x) => x.id === c.id);
    const v = verdict(c, r);
    const open = ev.appeals.find((a) => a.criterion_id === c.id && a.status === "open");
    return `
    <div class="crit">
      <div class="ic ${v.cls}">${v.ic}</div>
      <div>
        <div class="crit-top"><b title="${esc(c.description || "")}">${esc(c.text)}</b><span class="pill ${v.cls === "yes" ? "good" : v.cls === "no" ? "bad" : v.cls === "part" ? "mid" : ""}">${v.label}</span></div>
        <div class="why">${r.na ? `<b>N/A.</b> ${esc(r.na_reason)}` : esc(r.explanation)}</div>
        <div class="row">
          ${(r.evidence_ids || []).length ? `<span class="chip" data-ev="${r.evidence_ids.join(",")}" ${isCall ? 'data-play=""' : ""}>↳ ${r.evidence_ids.map((i) => "#" + i).join(" ")}${isCall ? " ▶" : ""}</span>` : ""}
          ${r.checked_span ? `<span class="chip" data-span="${esc(r.checked_span)}">🔎 проверено ${esc(r.checked_span)}</span>` : ""}
          <span class="muted">${c.critical_on === "yes" ? "без баллов, отмечается отдельно" : row?.applicable ? `баллы ${fmt(row.points, 2)} · вес ${c.weight} (после перераспределения N/A — ${fmt(row.effective_weight * 100, 1)})` : `вес ${c.weight} · N/A, вес перераспределён`}</span>
          ${r.overridden ? `<span class="pill info">изменено проверяющим, было: ${verdict(c, orig).label}</span>` : ""}
          <span class="spacer"></span>
          ${open ? '<span class="pill mid">апелляция на рассмотрении</span>' : `<a href="javascript:void 0" data-appeal="${c.id}">Оспорить</a>`}
        </div>
      </div>
    </div>`;
  }).join("");
}

function historyHtml(ev, history) {
  return `<div class="card-b stack">
    ${ev.appeals.length ? ev.appeals.map((a) => {
      const c = ev.checklist.criteria.find((x) => x.id === a.criterion_id);
      return `<div class="banner ${a.status === "open" ? "mid" : a.status === "changed" ? "info" : ""}" style="flex-direction:column;background:var(--panel-2);color:var(--ink)">
        <div><b>${esc(c?.text)}</b> · ${a.status === "open" ? "на рассмотрении" : a.status === "changed" ? "оценка изменена" : "оценка подтверждена"} · <span class="muted">${ago(a.created_at)}</span></div>
        <div class="small">Апелляция: «${esc(a.comment)}»</div>
        <div class="small">Было: <b>${verdict(c, a.original).label}</b>${a.decision ? ` → Решение: <b>${a.status === "changed" ? verdict(c, a.decision.result).label : "без изменений"}</b> — ${esc(a.decision.reason)}` : ""}</div></div>`;
    }).join("") : '<span class="muted">Апелляций нет.</span>'}
    <h4 style="margin:8px 0 0">Все оценки диалога</h4>
    <div class="list-links">${history.slice().reverse().map((h) => `<a href="javascript:void 0"><span>${ago(h.created_at)} · ${esc(h.checklist_id)} v${h.checklist_version} · ${esc(h.model)}</span><b>${h.total === null ? "N/A" : fmt(h.total)}</b></a>`).join("")}</div>
  </div>`;
}

function focusLines(root, ids, cls) {
  root.querySelectorAll(".msg.hit,.msg.span").forEach((n) => n.classList.remove("hit", "span"));
  ids.forEach((i) => root.querySelector(`#m${i}`)?.classList.add(cls));
  root.querySelector(`#m${ids[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function openAppeal(box, criterionId, ev, root, cid) {
  if (box.querySelector(".appeal-form")) return;
  const f = document.createElement("form");
  f.className = "appeal-form";
  f.innerHTML = `<textarea class="input" rows="3" required placeholder="Почему оценка неверна? Укажите номер реплики, например #12."></textarea>
    <div style="display:flex;gap:8px"><button class="btn primary">Отправить апелляцию</button><button type="button" class="btn ghost">Отмена</button></div>`;
  box.querySelector(".row").after(f);
  f.querySelector("textarea").focus();
  f.querySelector(".ghost").onclick = () => f.remove();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/appeals", { evaluation_id: ev.id, criterion_id: criterionId, comment: f.querySelector("textarea").value }); toast("Апелляция отправлена проверяющему"); refreshBadges(); render(root, [cid]); }
    catch (err) { toast(err.message, true); }
  };
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a) + 1 }, (_, k) => a + k);

// What the screen reader-independent "Озвучить" button reads: total, gross errors, then each criterion.
function speechParts(ev, conv) {
  const cl = ev.checklist, t = ev.totals, out = [];
  out.push(`Диалог ${conv.conversation_id.replace(/-/g, " ")}. Итог: ${t.total === null ? "не применимо" : fmt(t.total)} из ${t.max_score ?? 100}.`);
  for (const id of t.critical_errors || []) { const r = ev.final_results.find((x) => x.criterion_id === id); out.push(`Внимание, грубая ошибка. ${r?.explanation || ""}`); }
  for (const c of cl.criteria) {
    const r = ev.final_results.find((x) => x.criterion_id === c.id); if (!r) continue;
    if (c.critical_on === "yes" && r.answer === "yes") continue;
    const v = verdict(c, r).label.replace("N/A", "не применимо");
    const why = (r.na ? r.na_reason : r.explanation || "").replace(/\[(\d+)\]/g, "реплика $1").replace(/^[^—]*—\s*[^.]*\.\s*/, "");
    out.push(`${c.text}: ${v}. ${why}`);
  }
  return out;
}
