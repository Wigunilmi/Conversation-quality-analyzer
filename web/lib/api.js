// Shared helpers. No framework: every screen is a module with render(root, params),
// so each one can be packaged as a separate HTML web resource for Dynamics 365.

export async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || j.detail || res.statusText);
  return j;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3800);
}

export const scoreClass = (t) => (t === null || t === undefined ? "none" : t >= 85 ? "good" : t >= 65 ? "mid" : "low");
export const scoreHtml = (t) => `<span class="score ${scoreClass(t)}">${t === null || t === undefined ? "—" : fmt(t)}</span>`;
export const fmt = (n, d = 2) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("ru-RU", { maximumFractionDigits: d }));
export const LANG = { RU: "Русский", KZ: "Қазақша", EN: "English" };
export const CHANNEL = { "agent chat": "Чат", "voice call": "Звонок" };
export const channelIcon = (c) => (c === "voice call" ? "📞" : "💬");

// Criterion verdict → label + icon class.
export function verdict(c, r) {
  if (!r) return { label: "—", cls: "na", ic: "·" };
  if (r.na) return { label: "N/A", cls: "na", ic: "–" };
  if (c.type === "scale") {
    const share = (r.score - c.scale.min) / (c.scale.max - c.scale.min);
    return { label: `${r.score} из ${c.scale.max}`, cls: share >= 1 ? "yes" : share > 0 ? "part" : "no", ic: share >= 1 ? "✓" : share > 0 ? "◐" : "✗" };
  }
  if (c.critical_on === "yes") return r.answer === "yes" ? { label: "Нарушение", cls: "no", ic: "!" } : { label: "Нет нарушений", cls: "yes", ic: "✓" };
  return r.answer === "yes" ? { label: "Да", cls: "yes", ic: "✓" } : { label: "Нет", cls: "no", ic: "✗" };
}

// Seconds from the recording start (calls: ISO timestamps) or chat MM:SS.
export function toSec(ts) {
  if (!ts) return 0;
  if (/^\d+:\d{2}(:\d{2})?$/.test(ts)) return ts.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  return Date.parse(ts) / 1000;
}
export function offsetSec(transcript, i, baseIdx = 0) {
  const t = transcript[i]?.timestamp; if (!t) return 0;
  if (/^\d+:\d{2}/.test(t)) return toSec(t);
  return Math.max(0, Math.round(toSec(t) - toSec(transcript[baseIdx]?.timestamp)));
}
export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s) % 60).padStart(2, "0")}`;
export const timeLabel = (ts) => (/^\d+:\d{2}/.test(ts) ? ts : new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
export const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "только что" : s < 3600 ? `${Math.round(s / 60)} мин назад` : new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };

export function ring(value, max = 100, size = 112) {
  const r = size / 2 - 9, c = 2 * Math.PI * r, share = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value / max));
  const color = `var(--${{ good: "good", mid: "mid", low: "bad", none: "line" }[scoreClass(value === null ? null : (value / max) * 100)]})`;
  return `<div class="ring"><svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--line-2)" stroke-width="10" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - share)}" style="transition:stroke-dashoffset .6s"/></svg>
    <div class="num"><div><b>${value === null || value === undefined ? "N/A" : fmt(value)}</b><small>из ${max}</small></div></div></div>`;
}

export function confHtml(conf) {
  if (conf === null || conf === undefined) return "";
  const c = conf >= 0.85 ? "var(--good)" : conf >= 0.67 ? "var(--mid)" : "var(--bad)";
  return `<span class="conf" title="Уверенность модели">уверенность <i style="--w:${Math.round(conf * 100)}%;--c:${c}"></i> ${Math.round(conf * 100)}%</span>`;
}

// Run async tasks with a concurrency limit, reporting progress; returns a cancel function via signal.
export async function runPool(items, n, fn, onProgress, signal) {
  let i = 0, done = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) {
      const k = i++;
      try { await fn(items[k]); } catch { failed++; }
      done++; onProgress?.(done, items.length, failed);
    }
  }));
  return { done, failed };
}

export const debounce = (fn, ms = 200) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
