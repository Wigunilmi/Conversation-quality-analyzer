// Theme + accessibility preferences. Stored per browser (localStorage), applied as data-* on <html>,
// so every screen and a Dynamics 365 web resource get them through CSS only.
const KEY = "cqa-prefs";
const d = document.documentElement;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const write = (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} };
const mq = matchMedia("(prefers-color-scheme: dark)");

export function applyPrefs(p = read()) {
  d.dataset.theme = p.theme === "dark" || (p.theme !== "light" && mq.matches) ? "dark" : "light";
  for (const k of ["contrast", "cvd", "readable", "still"]) p[k] ? (d.dataset[k] = "on") : delete d.dataset[k];
  p.zoom ? d.style.setProperty("--zoom", p.zoom) : d.style.removeProperty("--zoom");
  document.querySelectorAll("[data-theme-set]").forEach((b) => { const on = (p.theme || "auto") === b.dataset.themeSet; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
  document.querySelectorAll("[data-pref]").forEach((c) => (c.checked = !!p[c.dataset.pref]));
  const z = document.getElementById("z-val"); if (z) z.textContent = `${Math.round((p.zoom || 1) * 100)}%`;
  const n = ["contrast", "cvd", "readable", "still"].filter((k) => p[k]).length + (p.zoom && p.zoom !== 1 ? 1 : 0);
  const badge = document.getElementById("a11y-on"); if (badge) { badge.textContent = n; badge.classList.toggle("hidden", !n); }
}
const set = (patch) => { const p = { ...read(), ...patch }; write(p); applyPrefs(p); };

export function initPrefs() {
  applyPrefs();
  mq.addEventListener?.("change", () => applyPrefs());
  document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => set({ theme: b.dataset.themeSet === "auto" ? undefined : b.dataset.themeSet })));
  document.querySelectorAll("[data-pref]").forEach((c) => (c.onchange = () => set({ [c.dataset.pref]: c.checked || undefined })));
  const zoom = (z) => set({ zoom: z === 1 ? undefined : z });
  const cur = () => read().zoom || 1;
  document.getElementById("z-in").onclick = () => zoom(Math.min(1.6, +(cur() + 0.1).toFixed(2)));
  document.getElementById("z-out").onclick = () => zoom(Math.max(0.9, +(cur() - 0.1).toFixed(2)));
  document.getElementById("z-reset").onclick = () => zoom(1);
  document.getElementById("a11y-reset").onclick = () => { const { theme } = read(); write(theme ? { theme } : {}); applyPrefs(); };

  const panel = document.getElementById("a11y-panel"), open = document.getElementById("a11y-open");
  const show = (on) => { panel.hidden = !on; open.setAttribute("aria-expanded", String(on)); if (on) panel.querySelector("input,button")?.focus(); else open.focus(); };
  open.onclick = () => show(panel.hidden);
  document.getElementById("a11y-close").onclick = () => show(false);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) show(false); });
  // Alt+A opens the panel from anywhere.
  addEventListener("keydown", (e) => { if (e.altKey && (e.key === "a" || e.key === "ф" || e.code === "KeyA")) { e.preventDefault(); show(panel.hidden); } });
}

// ---------- Text-to-speech (Web Speech API, no server). ----------
const VOICE_LANG = { RU: "ru-RU", KZ: "kk-KZ", EN: "en-US" };
export const ttsSupported = () => "speechSynthesis" in window;
export function speak(parts, lang = "RU", onEnd) {
  if (!ttsSupported()) return false;
  speechSynthesis.cancel();
  const want = VOICE_LANG[lang] || "ru-RU", voices = speechSynthesis.getVoices();
  // Kazakh voices are rare: fall back to Russian, which reads Kazakh Cyrillic acceptably.
  const voice = voices.find((v) => v.lang === want) || voices.find((v) => v.lang.startsWith(want.slice(0, 2))) || voices.find((v) => v.lang.startsWith("ru"));
  const list = parts.filter(Boolean);
  list.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = want;
    u.rate = 1;
    if (i === list.length - 1) u.onend = () => onEnd?.();
    speechSynthesis.speak(u);
  });
  return true;
}
export const stopSpeaking = () => ttsSupported() && speechSynthesis.cancel();
