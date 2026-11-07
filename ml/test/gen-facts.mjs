// Generates test/fixtures/facts.json from a local DEV dump (chats only, they are synthetic) + one synthetic call.
// Usage: node test/gen-facts.mjs path/to/dev.json
import fs from "node:fs";
import { extractFacts, factsText } from "../lib/facts.mjs";
const recs = JSON.parse(fs.readFileSync(process.argv[2])).data.records.filter((r) => r.channel === "agent chat");
const call = { conversation_id: "synthetic-call", channel: "voice call", language: "RU", transcript: [
  { timestamp: "2026-11-03T10:00:00.1234567+00:00", speaker: "system", text: "Запись и транскрибирование запущены." },
  { timestamp: "2026-11-03T10:00:05.5000000+00:00", speaker: "bot", text: "Здравствуйте, добро пожаловать в Фридом брокер." },
  { timestamp: "2026-11-03T10:00:20+00:00", speaker: "system", text: "Агент присоединился к разговору с клиентом." },
  { timestamp: "2026-11-03T10:00:31.999+00:00", speaker: "operator", text: "Здравствуйте, меня зовут [Имя скрыто], чем могу помочь?" },
  { timestamp: "2026-11-03T10:00:40+00:00", speaker: "client", text: "Хочу узнать баланс счёта." },
  { timestamp: "2026-11-03T10:04:50+00:00", speaker: "operator", text: "Дайте личный номер, проконсультирую за плату." },
  { timestamp: "2026-11-03T10:05:10+00:00", speaker: "client", text: "Ты идиот? Нет." },
  { timestamp: "2026-11-03T10:05:30+00:00", speaker: "system", text: "Соединение с клиентом прервано." },
] };
const cases = [...recs, call].map((c) => { const f = extractFacts(c); return { conv: c, facts: f, text: factsText(f) }; });
fs.writeFileSync(new URL("./fixtures/facts.json", import.meta.url), JSON.stringify(cases));
console.log(cases.length, "cases");
