// One-time setup of a fresh FastAPI backend: chat + call checklist sets bound to their channels, then a group load.
// Usage: node tools/seed-backend.mjs https://<backend-host> [--group DEV]
import fs from "node:fs";
const args = process.argv.slice(2);
const B = (args.find((a) => a.startsWith("http")) || "http://localhost:8000").replace(/\/$/, "");
const group = args.includes("--group") ? args[args.indexOf("--group") + 1] : "DEV";
const call = async (p, body) => { const r = await fetch(B + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p}: ${r.status} ${j.error || j.detail || ""}`); return j; };
const sets = await call("/api/checklists");
for (const [file, channel] of [["chat", "agent chat"], ["call", "voice call"]]) {
  if (sets.some((s) => s.channels.includes(channel))) { console.log(`✓ ${channel}: чек-лист уже привязан`); continue; }
  const cl = JSON.parse(fs.readFileSync(new URL(`../checklists/${file}.json`, import.meta.url)));
  const { id } = await call("/api/checklists", { name: cl.name || file, channels: [channel], checklist: cl, note: "начальная версия" });
  console.log(`✓ ${channel}: создан чек-лист ${id}`);
}
console.log(`✓ группа ${group}: загружено ${(await call(`/api/groups/${encodeURIComponent(group)}/load`, {})).loaded}`);
