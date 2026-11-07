import { api, esc, toast, fmt } from "../lib/api.js";

let draft = null, draftOf = null, dirty = false;
const CHANNELS = [["agent chat", "💬 Чаты"], ["voice call", "📞 Звонки"]];
const COLORS = ["#0b8f4d", "#2563eb", "#9333ea", "#d97706", "#db2777", "#0891b2", "#65a30d", "#64748b"];

export async function render(root, [id]) {
  const sets = await api("/api/checklists");
  const cur = sets.find((s) => s.id === id) || sets[0];
  if (!cur) { root.innerHTML = '<div class="page"><div class="card empty"><b>Чек-листов нет</b></div></div>'; return; }
  if (draftOf !== cur.id || !draft) { draft = structuredClone(cur.active_checklist); draftOf = cur.id; dirty = false; }
  const wSum = draft.criteria.filter((c) => c.critical_on !== "yes").reduce((s, c) => s + Number(c.weight || 0), 0);
  // One color per scored criterion; the bar, the legend and the criterion number share it.
  const scored = draft.criteria.map((c, k) => ({ c, n: String(k + 1).padStart(2, "0") })).filter(({ c }) => c.critical_on !== "yes" && Number(c.weight) > 0).map((x, i) => ({ ...x, color: COLORS[i % COLORS.length] }));
  const colorOf = (c) => scored.find((x) => x.c === c)?.color;
  const nextV = Math.max(...cur.versions.map((v) => v.version)) + 1;

  root.innerHTML = `
  <div class="page">
    <div class="page-head"><h1>Чек-листы</h1><span class="sub">Гибкая настройка: несколько чек-листов, привязка к каналу, версии</span><span class="spacer"></span>
      <button class="btn" id="dup">⧉ Новый на основе текущего</button></div>
    <div class="cl-layout">
      <div class="card cl-list">${sets.map((s) => `<a href="#/checklists/${encodeURIComponent(s.id)}" class="${s.id === cur.id ? "on" : ""}">
          <b>${esc(s.name)}</b><div class="small muted">${s.channels.map((c) => CHANNELS.find((x) => x[0] === c)?.[1] || c).join(", ") || "не привязан к каналу"} · v${s.active} · ${s.active_checklist.criteria.length} крит.</div></a>`).join("")}</div>
      <div class="stack">
        <div class="card card-b stack">
          <div class="toolbar" style="margin:0">
            <input class="input" id="name" value="${esc(draft.name || "")}" style="flex:1;font-weight:600" />
            <span class="pill info">активная v${cur.active}</span>${dirty ? '<span class="pill mid">есть несохранённые изменения</span>' : ""}
          </div>
          <div class="toolbar" style="margin:0">
            <span class="muted small">Применять к:</span>
            ${CHANNELS.map(([v, l]) => `<label class="chk"><input type="checkbox" data-ch="${v}" ${cur.channels.includes(v) ? "checked" : ""}/> ${l}</label>`).join("")}
            <span class="spacer"></span>
            <label class="small muted">Округление <input class="input" id="dec" type="number" min="0" max="3" value="${draft.rounding?.decimals ?? 2}" style="width:56px"/> знака</label>
            <label class="chk small"><input id="cz" type="checkbox" ${draft.critical_zeroes_total ? "checked" : ""}/> грубая ошибка обнуляет итог</label>
          </div>
          <div>
            <div class="small muted" style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Веса критериев</span><b style="color:${wSum === 100 ? "var(--good)" : "var(--mid)"}">сумма ${fmt(wSum)}${wSum === 100 ? " ✓" : " — при N/A всё равно нормируется к 100"}</b></div>
            <div class="weightbar">${scored.map(({ c, color }) => `<i title="${esc(c.text)}: ${c.weight}" style="width:${wSum ? (c.weight / wSum) * 100 : 0}%;background:${color}"></i>`).join("")}</div>
            <div class="wlegend">${scored.map(({ c, n, color }) => `<span title="${esc(c.text)}"><i style="background:${color}"></i>${n} ${esc(c.text)} <b>${fmt(c.weight)}</b></span>`).join("")}${draft.criteria.some((c) => c.critical_on === "yes") ? `<span class="muted"><i style="background:var(--bad)"></i>Грубые ошибки — без веса, отдельный флаг</span>` : ""}</div>
          </div>
        </div>

        <div class="stack" id="crits">${draft.criteria.map((c, i) => critEditor(c, i, colorOf(c))).join("")}</div>

        <div class="card card-b stack">
          <div class="toolbar" style="margin:0">
            <button class="btn" id="add">＋ Критерий</button>
            <input class="input" id="note" placeholder="Что изменилось? Например: «заменён критерий 05»" style="flex:1" />
            <button class="btn ghost" id="reset">Сбросить</button>
            <button class="btn primary" id="save">Сохранить как v${nextV}</button>
          </div>
          <div class="small muted">После сохранения новая версия станет активной. Диалоги, оценённые по старой, получат отметку «устарела» — на вкладке «Диалоги» нажмите «Оценить», и они переоценятся.</div>
        </div>

        <div class="card card-b">
          <details><summary><b>История версий</b> (${cur.versions.length})</summary>
            <div class="list-links" style="margin-top:8px">${cur.versions.slice().reverse().map((v) => `<a href="javascript:void 0"><span>v${v.version} · ${new Date(v.created_at).toLocaleString("ru-RU")} · ${v.checklist.criteria.length} крит. · ${esc(v.note || "")}</span>
              ${v.version === cur.active ? '<span class="pill good">активна</span>' : `<button class="btn ghost small" data-activate="${v.version}">Сделать активной</button>`}</a>`).join("")}</div>
          </details>
          <details style="margin-top:10px"><summary><b>JSON</b> — импорт / экспорт</summary>
            <textarea class="input mono" id="json" rows="12" style="margin-top:8px">${esc(JSON.stringify(draft, null, 2))}</textarea>
            <button class="btn" id="import" style="margin-top:8px">Загрузить JSON в редактор</button>
          </details>
        </div>
      </div>
    </div>
  </div>`;

  const q = (s) => root.querySelector(s);
  const rer = () => render(root, [cur.id]);
  const touch = () => { dirty = true; };

  q("#crits").addEventListener("input", (e) => {
    const box = e.target.closest("[data-i]"); const k = e.target.dataset.k; if (!box || !k) return;
    const c = draft.criteria[Number(box.dataset.i)]; const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    touch();
    if (k === "weight") { c.weight = Number(v); return; }
    if (k === "min" || k === "max") { c.scale = { ...(c.scale || {}), [k]: Number(v) }; return; }
    if (k === "steps") { c.scale = { ...(c.scale || {}), steps: v.split("\n").map((l) => l.split("|")).filter((p) => p[0].trim() !== "").map(([val, ...rest]) => ({ value: Number(val), label: rest.join("|").trim() })) }; return; }
    c[k] = v;
  });
  q("#crits").addEventListener("change", (e) => {
    const box = e.target.closest("[data-i]"); const k = e.target.dataset.k; if (!box) return;
    const i = Number(box.dataset.i), c = draft.criteria[i];
    if (k === "weight") return rer();
    if (k === "type") { c.type = e.target.value; if (c.type === "scale" && !c.scale) c.scale = { min: 0, max: 10, steps: [{ value: 10, label: "Отлично" }, { value: 5, label: "Частично" }, { value: 0, label: "Не выполнено" }] }; return rer(); }
    if (k === "na_allowed") { c.na_allowed = e.target.checked; return rer(); }
    if (k === "critical") { c.critical = e.target.checked; c.critical_on = e.target.checked ? "yes" : undefined; if (c.critical) c.weight = 0; return rer(); }
  });
  q("#crits").onclick = (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const i = Number(b.closest("[data-i]").dataset.i); touch();
    if (b.dataset.act === "del") draft.criteria.splice(i, 1);
    if (b.dataset.act === "up" && i > 0) [draft.criteria[i - 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i - 1]];
    if (b.dataset.act === "down" && i < draft.criteria.length - 1) [draft.criteria[i + 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i + 1]];
    rer();
  };
  q("#name").oninput = (e) => { draft.name = e.target.value; touch(); };
  q("#dec").onchange = (e) => { draft.rounding = { ...(draft.rounding || {}), decimals: Number(e.target.value) }; touch(); };
  q("#cz").onchange = (e) => { draft.critical_zeroes_total = e.target.checked; touch(); };
  q("#add").onclick = () => { draft.criteria.push({ id: `c${String(draft.criteria.length + 1).padStart(2, "0")}_new`, section: draft.criteria.at(-1)?.section || "", text: "Новый критерий", description: "Да — …", weight: 10, type: "binary", na_allowed: false, na_rule: "", critical: false }); touch(); rer(); };
  q("#reset").onclick = () => { draft = null; rer(); };
  q("#import").onclick = () => { try { draft = JSON.parse(q("#json").value); touch(); rer(); } catch (e) { toast("JSON: " + e.message, true); } };
  q("#save").onclick = async () => {
    try { const r = await api(`/api/checklists/${encodeURIComponent(cur.id)}/versions`, { checklist: draft, note: q("#note").value }); draft = null; toast(`Сохранено как v${r.version} и сделано активным`); rer(); }
    catch (e) { toast(e.message, true); }
  };
  root.querySelectorAll("[data-ch]").forEach((cb) => (cb.onchange = async () => {
    const channels = [...root.querySelectorAll("[data-ch]:checked")].map((x) => x.dataset.ch);
    try { await api(`/api/checklists/${encodeURIComponent(cur.id)}/activate`, { channels }); const orphan = CHANNELS.filter(([v]) => !channels.includes(v) && !sets.some((x) => x.id !== cur.id && x.channels.includes(v)));
      toast(orphan.length ? `Внимание: у канала ${orphan.map((o) => o[1]).join(", ")} теперь нет чек-листа — привяжите его к другому набору` : "Привязка к каналам обновлена", !!orphan.length); rer(); } catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll("[data-activate]").forEach((b) => (b.onclick = async () => {
    try { await api(`/api/checklists/${encodeURIComponent(cur.id)}/activate`, { version: Number(b.dataset.activate) }); draft = null; toast(`Активна v${b.dataset.activate}`); rer(); } catch (e) { toast(e.message, true); }
  }));
  q("#dup").onclick = async () => {
    const name = prompt("Название нового чек-листа", `${draft.name} (копия)`); if (!name) return;
    try { const r = await api("/api/checklists", { name, channels: [], checklist: { ...draft, name } }); draft = null; location.hash = `#/checklists/${encodeURIComponent(r.id)}`; } catch (e) { toast(e.message, true); }
  };
}

function critEditor(c, i, color) {
  const isFlag = c.critical_on === "yes";
  return `<div class="crit-edit" data-i="${i}">
    <div class="head"><span class="n"${color ? ` style="color:${color};font-weight:700"` : ""}>${color ? `<i class="cdot" style="background:${color}"></i>` : ""}${String(i + 1).padStart(2, "0")}</span>
      <input class="input" data-k="text" value="${esc(c.text)}" style="flex:1;font-weight:600" />
      <button class="btn ghost" data-act="up" title="Выше">↑</button><button class="btn ghost" data-act="down" title="Ниже">↓</button><button class="btn ghost danger" data-act="del" title="Удалить">✕</button></div>
    <label class="full">Когда ставить «Да» / что оценивать<textarea class="input" data-k="description" rows="2">${esc(c.description || "")}</textarea></label>
    <label>Секция<input class="input" data-k="section" value="${esc(c.section || "")}" /></label>
    <label>ID<input class="input mono" data-k="id" value="${esc(c.id)}" /></label>
    <label>Тип ответа<select class="input" data-k="type"><option value="binary" ${c.type === "binary" ? "selected" : ""}>Да / Нет</option><option value="scale" ${c.type === "scale" ? "selected" : ""}>Шкала</option></select></label>
    <label>Вес${isFlag ? " (без баллов)" : ""}<input class="input" type="number" min="0" data-k="weight" value="${c.weight}" ${isFlag ? "disabled" : ""} /></label>
    ${c.type === "scale" ? `<label>Мин.<input class="input" type="number" data-k="min" value="${c.scale?.min ?? 0}" /></label><label>Макс.<input class="input" type="number" data-k="max" value="${c.scale?.max ?? 10}" /></label>
      <label class="half">Ступени шкалы — «значение | описание», по строке<textarea class="input" data-k="steps" rows="${Math.max(3, c.scale?.steps?.length || 3)}">${esc((c.scale?.steps || []).map((s) => `${s.value} | ${s.label}`).join("\n"))}</textarea></label>` : ""}
    <label class="chk" style="flex-direction:row"><input type="checkbox" data-k="na_allowed" ${c.na_allowed ? "checked" : ""} ${isFlag ? "disabled" : ""}/> Разрешён N/A</label>
    <label class="chk" style="flex-direction:row"><input type="checkbox" data-k="critical" ${c.critical ? "checked" : ""}/> Грубая ошибка («Да» = нарушение)</label>
    ${c.na_allowed ? `<label class="half">Условие N/A<input class="input" data-k="na_rule" value="${esc(c.na_rule || "")}" /></label>` : ""}
  </div>`;
}
