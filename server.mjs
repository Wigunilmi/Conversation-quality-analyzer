// Local server: static UI from ./web + the API router. On Vercel the same router runs in api/index.mjs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleApi } from "./lib/app.mjs";
import apiHandler from "./api/index.mjs";
import { backend } from "./lib/store.mjs";

const PORT = Number(process.env.PORT || 3000);
const WEB = path.resolve("web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return apiHandler(req, res); // BACKEND_URL set → FastAPI (+ bridge), else built-in API
  const f = path.join(WEB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`CQA on http://localhost:${PORT}  (evaluator: ${process.env.LLM_API_KEY ? process.env.LLM_MODEL : "MOCK"}, store: ${backend})`));
