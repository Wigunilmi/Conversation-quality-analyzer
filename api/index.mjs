// Vercel function: every /api/* request is rewritten here (see vercel.json).
// If BACKEND_URL is set (the FastAPI backend), requests are proxied to it; otherwise the built-in
// reference API (lib/app.mjs) answers. Switching = set/remove one env var in Vercel and redeploy.
import { handleApi } from "../lib/app.mjs";
import { bridge } from "../lib/bridge.mjs";

export default async function handler(req, res) {
  const backend = process.env.BACKEND_URL?.replace(/\/$/, "");
  if (!backend) return handleApi(req, res);
  if (req.url.startsWith("/api/index")) req.url = req.headers["x-forwarded-uri"] || req.headers["x-original-url"] || req.headers["x-invoke-path"] || req.url;
  // Service token of the backend (its API_AUTH_TOKEN). Stays on the server: the browser never sees it.
  const auth = process.env.BACKEND_TOKEN ? { authorization: `Bearer ${process.env.BACKEND_TOKEN}` } : {};
  if (await bridge(req, res, backend, auth)) return; // routes the backend does not implement yet
  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      else { const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks).toString("utf8") || undefined; } // local server: raw stream
    }
    const path = req.url;
    const r = await fetch(backend + path, { method: req.method, headers: { "content-type": req.headers["content-type"] || "application/json", ...auth }, body });
    res.statusCode = r.status;
    for (const h of ["content-type", "content-disposition"]) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.statusCode = 502; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: `backend unreachable: ${e.message}` }));
  }
}
