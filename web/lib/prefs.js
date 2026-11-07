// Theme + accessibility modes. Stored per browser (localStorage), applied as data-* on <html>,
// so every screen and a Dynamics 365 web resource get them through CSS only.
const KEY = "cqa-prefs";
const d = document.documentElement;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const write = (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} };
const mq = matchMedia("(prefers-color-scheme: dark)");

// One-click modes: each replaces the accessibility settings at once (the theme is kept); a second click turns it off.
const MODES = ["contrast", "cvd", "zoom"];
const PROFILES = {
  lowvision: { contrast: true, zoom: 1.3 }, // крупный текст + высокий контраст
  colorblind: { cvd: true },                // синий / оранжевый вместо зелёного / красного + значки
};

export function applyPrefs(p = read()) {
  d.dataset.theme = p.theme === "dark" || (p.theme !== "light" && mq.matches) ? "dark" : "light";
  for (const k of ["contrast", "cvd"]) p[k] ? (d.dataset[k] = "on") : delete d.dataset[k];
  p.zoom ? d.style.setProperty("--zoom", p.zoom) : d.style.removeProperty("--zoom");
  document.querySelectorAll("[data-theme-set]").forEach((b) => { const on = (p.theme || "auto") === b.dataset.themeSet; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
  document.querySelectorAll("[data-profile]").forEach((b) => { const on = p.profile === b.dataset.profile; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
}

function setProfile(name) {
  const cur = read(), base = Object.fromEntries(Object.entries(cur).filter(([k]) => !MODES.includes(k) && k !== "profile"));
  const p = cur.profile === name ? base : { ...base, ...PROFILES[name], profile: name };
  write(p); applyPrefs(p);
}

export function initPrefs() {
  applyPrefs();
  mq.addEventListener?.("change", () => applyPrefs());
  document.querySelectorAll("[data-theme-set]").forEach((b) => (b.onclick = () => { const p = { ...read(), theme: b.dataset.themeSet === "auto" ? undefined : b.dataset.themeSet }; write(p); applyPrefs(p); }));
  document.querySelectorAll("[data-profile]").forEach((b) => (b.onclick = () => setProfile(b.dataset.profile)));
}

// ---------- Text-to-speech (Web Speech API, no server). ----------
const VOICE_LANG = { RU: "ru-RU", KZ: "kk-KZ", EN: "en-US" };
export const ttsSupported = () => "speechSynthesis" in window;
export function speak(parts, lang = "RU", onEnd) {
  if (!ttsSupported()) return false;
  speechSynthesis.cancel();
  const want = VOICE_LANG[lang] || "ru-RU", voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === want) || voices.find((v) => v.lang.startsWith(want.slice(0, 2))) || voices.find((v) => v.lang.startsWith("ru"));
  const list = parts.filter(Boolean);
  list.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = want;
    if (i === list.length - 1) u.onend = () => onEnd?.();
    speechSynthesis.speak(u);
  });
  return true;
}
export const stopSpeaking = () => ttsSupported() && speechSynthesis.cancel();
