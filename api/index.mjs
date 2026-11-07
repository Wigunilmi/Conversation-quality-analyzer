// Vercel function: every /api/* request is rewritten here (see vercel.json).
// If BACKEND_URL is set (the FastAPI backend), requests are proxied to it; otherwise the built-in
// reference API (lib/app.mjs) answers. Switching = set/remove one env var in Vercel and redeploy.
import { handleApi } from "../lib/app.mjs";

export default async function handler(req, res) {
  const backend = process.env.BACKEND_URL?.replace(/\/$/, "");
  if (!backend) return handleApi(req, res);
  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    let path = req.url;
    if (path.startsWith("/api/index")) path = req.headers["x-forwarded-uri"] || req.headers["x-original-url"] || req.headers["x-invoke-path"] || path;
    const r = await fetch(backend + path, { method: req.method, headers: { "content-type": req.headers["content-type"] || "application/json" }, body });
    res.statusCode = r.status;
    for (const h of ["content-type", "content-disposition"]) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.statusCode = 502; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: `backend unreachable: ${e.message}` }));
  }
}
