// Prompt parity fixture: the Python backend must send the model exactly what the JS reference sends.
import fs from "node:fs";
import { buildPrompt } from "../lib/evaluator.mjs";
const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/facts.json", import.meta.url))).filter((_, i, a) => i % 10 === 0 || i === a.length - 1);
const cls = ["chat", "call"].map((f) => JSON.parse(fs.readFileSync(new URL(`../checklists/${f}.json`, import.meta.url))));
const out = cases.map((c) => { const cl = c.conv.channel === "voice call" ? cls[1] : cls[0]; return { conv: c.conv, checklist_id: cl.id, prompt: buildPrompt(c.conv, cl) }; });
// one case with few-shot examples
const ex = [{ conv: cases[1].conv, gold: { c01_contact: "yes", c04_consultation: "15", c08_gross: "no" } }];
out.push({ conv: cases[0].conv, checklist_id: "chat", examples: ex, prompt: buildPrompt(cases[0].conv, cls[0], undefined, ex) });
fs.writeFileSync(new URL("./fixtures/prompts.json", import.meta.url), JSON.stringify(out));
console.log(out.length, "prompts");
