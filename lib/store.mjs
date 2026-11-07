// Document store with two backends:
//   • local JSON files in ./data (default, for `npm start`)
//   • Supabase/Postgres table `cqa_docs` (SUPABASE_URL + SUPABASE_KEY), used on Vercel where there is no disk
// A collection is either an object keyed by id (conversations) or an array of docs with `id` (evaluations…).
// save() only upserts changed docs and never deletes, so parallel requests do not lose each other's writes.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_KEY;
const remote = !!(SB_URL && SB_KEY);
const DIR = process.env.DATA_DIR || path.resolve("data");
if (!remote) fs.mkdirSync(DIR, { recursive: true });

// Per-request cache: every load in one HTTP request sees the same snapshot (and its own writes).
const ctx = new AsyncLocalStorage();
export const withRequestCache = (fn) => ctx.run(new Map(), fn);
const cache = () => ctx.getStore() || new Map();

const ARRAYS = new Set(["evaluations", "appeals", "checklist_sets"]);
export const backend = remote ? "supabase" : "files";

export async function load(name, fallback) {
  const c = cache();
  if (c.has(name)) return c.get(name).value;
  let value = fallback;
  if (remote) {
    const docs = await sbSelect(name);
    if (docs.length) value = ARRAYS.has(name) ? docs.map((d) => d.data) : Object.fromEntries(docs.map((d) => [d.id, d.data]));
    else if (fallback !== null && fallback !== undefined) value = fallback;
  } else {
    try { value = JSON.parse(fs.readFileSync(file(name), "utf8")); } catch {}
  }
  c.set(name, { value, snap: snapshot(name, value) });
  return value;
}

export async function save(name, value) {
  const c = cache(); const prev = c.get(name)?.snap || new Map();
  const snap = snapshot(name, value);
  c.set(name, { value, snap });
  if (remote) {
    const changed = [...snap].filter(([id, json]) => prev.get(id) !== json).map(([id, json]) => ({ collection: name, id, data: JSON.parse(json), updated_at: new Date().toISOString() }));
    for (let i = 0; i < changed.length; i += 200) await sbUpsert(changed.slice(i, i + 200));
  } else {
    const tmp = file(name) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file(name));
  }
}

export const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const file = (name) => path.join(DIR, `${name}.json`);
function snapshot(name, value) {
  const m = new Map();
  if (value === null || value === undefined) return m;
  if (Array.isArray(value)) value.forEach((d) => m.set(String(d.id), JSON.stringify(d)));
  else Object.entries(value).forEach(([id, d]) => m.set(id, JSON.stringify(d)));
  return m;
}

const H = () => ({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" });
async function sbSelect(name) {
  const out = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const r = await fetch(`${SB_URL}/rest/v1/cqa_docs?collection=eq.${encodeURIComponent(name)}&select=id,data&order=seq.asc`, { headers: { ...H(), range: `${from}-${from + page - 1}` } });
    if (!r.ok) throw new Error(`store ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < page) return out;
  }
}
async function sbUpsert(rows) {
  const r = await fetch(`${SB_URL}/rest/v1/cqa_docs?on_conflict=collection,id`, { method: "POST", headers: { ...H(), prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`store ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
