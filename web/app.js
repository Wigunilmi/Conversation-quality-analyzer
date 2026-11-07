// Hash router. Each screen is a self-contained module: export async function render(root, params).
import * as list from "./screens/list.js";
import * as card from "./screens/card.js";
import * as checklists from "./screens/checklists.js";
import * as appeals from "./screens/appeals.js";
import { api } from "./lib/api.js";
import { initPrefs, stopSpeaking } from "./lib/prefs.js";

initPrefs();

const routes = [
  [/^#\/list$/, list, "list"],
  [/^#\/c\/([^/]+)$/, card, "list"],
  [/^#\/checklists(?:\/([^/]+))?$/, checklists, "checklists"],
  [/^#\/appeals$/, appeals, "appeals"],
];

let current = null;
async function route() {
  const hash = location.hash || "#/list";
  const root = document.getElementById("app");
  for (const [re, mod, nav] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", a.dataset.r === nav);
    current?.unmount?.(); stopSpeaking();
    current = mod;
    root.innerHTML = '<div class="page"><div class="skel" style="width:220px;height:26px;margin-bottom:18px"></div><div class="skel" style="height:300px"></div></div>';
    try { await mod.render(root, m.slice(1).filter(Boolean).map(decodeURIComponent)); }
    catch (e) { root.innerHTML = `<div class="page"><div class="banner bad">${e.message}</div></div>`; }
    refreshBadges();
    return;
  }
  location.hash = "#/list";
}

export async function refreshBadges() {
  try {
    const open = (await api("/api/appeals?status=open")).length;
    const b = document.getElementById("ap-count"); b.textContent = open; b.classList.toggle("hidden", !open);
  } catch {}
}

api("/api/health").then((h) => {
  document.getElementById("model").textContent = h.llm === "MOCK" ? "MOCK — модель не подключена" : `${h.llm}${h.votes > 1 ? ` · ${h.votes} голоса` : ""}`;
  document.getElementById("model-dot").classList.toggle("mock", h.llm === "MOCK");
}).catch(() => {});
addEventListener("hashchange", route);
route();
