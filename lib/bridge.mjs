// Bridge between the web UI and the team's FastAPI backend (branch `backend`).
// The backend implements the core contract (conversations, evaluate, batch, checklists, appeals).
// Routes it does not have yet are answered here from the backend's own data, so the UI keeps working
// and nothing is stored on the Vercel side. Everything else is passed through unchanged.
import { buildResults } from "./results.mjs";

const json = (res, code, data) => { res.statusCode = code; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(data)); return true; };

export async function bridge(req, res, backend) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname, q = Object.fromEntries(url.searchParams);
  const get = async (p) => { const r = await fetch(backend + p); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { error: t.slice(0, 200) }; } if (!r.ok) { const e = new Error(j.error || j.detail || r.statusText); e.status = r.status; throw e; } return j; };
  const card = (cid) => get(`/api/conversations/${encodeURIComponent(cid)}`);
  const pool = async (items, n, fn) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } })); return out; };

  try {
    if (req.method === "GET" && path === "/api/health") {
      const h = await get("/health").catch(() => null);
      return json(res, 200, { ok: !!h, store: "backend", backend: h ? "ok" : "unreachable", llm: process.env.LLM_MODEL || "backend", votes: 1 });
    }
    if (req.method === "GET" && path === "/api/groups") {
      const rows = await get("/api/conversations");
      return json(res, 200, [...new Set(rows.map((r) => r.group_id).filter(Boolean))].sort());
    }
    if (req.method === "GET" && path === "/api/conversations") {
      // Gross-error flag + reason for the «⚠ Грубые ошибки» filter (derived from the evaluation's critical criterion).
      const rows = await get(`/api/conversations${q.group ? `?group=${encodeURIComponent(q.group)}` : ""}`);
      const gross = rows.filter((r) => (r.critical || []).length);
      const reasons = await pool(gross, 6, async (r) => {
        const ev = (await card(r.conversation_id)).evaluation;
        return (r.critical || []).map((id) => (ev?.final_results || ev?.results || []).find((x) => x.criterion_id === id)?.explanation || "").join(" ");
      });
      const reason = new Map(gross.map((r, i) => [r.conversation_id, reasons[i] || ""]));
      const out = rows.map((r) => ({ ...r, gross_error: r.gross_error ?? (r.critical || []).length > 0, gross_reason: r.gross_reason ?? reason.get(r.conversation_id) ?? "" }));
      return json(res, 200, q.gross === "1" ? out.filter((r) => r.gross_error) : out);
    }
    let m;
    if (req.method === "GET" && (m = path.match(/^\/api\/conversations\/([^/]+)\/audio$/))) {
      const conv = (await card(decodeURIComponent(m[1]))).conversation;
      if (!conv?.audio_url) return json(res, 404, { error: "no audio" });
      const html = await (await fetch(conv.audio_url)).text();
      const s = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/<audio[^>]+src="([^"]+)"/i);
      if (!s) return json(res, 502, { error: "audio source not found" });
      return json(res, 200, { src: s[1].replace(/&amp;/g, "&"), page: conv.audio_url });
    }
    if (req.method === "GET" && path === "/api/export") {
      const rows = await get(`/api/conversations${q.group ? `?group=${encodeURIComponent(q.group)}` : ""}`);
      const items = (await pool(rows, 6, async (r) => { const c = await card(r.conversation_id); return { conversation: c.conversation, evaluation: c.evaluation }; })).filter(Boolean);
      return json(res, 200, buildResults(items, { team: q.team }));
    }
    if (req.method === "POST" && path === "/api/conversations") {
      return json(res, 501, { error: "Ручная загрузка транскрипта пока не поддерживается сервером бэкенда. Загрузите набор по group_id." });
    }
  } catch (e) {
    return json(res, e.status || 502, { error: e.message });
  }
  return null; // not handled: pass through
}
