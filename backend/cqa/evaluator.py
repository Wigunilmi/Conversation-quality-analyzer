"""LLM judge — Python port of lib/evaluator.mjs. Plug into FastAPI as:

    from cqa.evaluator import evaluate
    result = await run_in_threadpool(evaluate, conversation, checklist)

Pipeline: facts (code) → LLM judge (OpenAI-compatible, strict JSON) → sanitize (+1 repair retry)
→ optional majority vote over LLM_VOTES runs (agreement = confidence) → scoring.py computes numbers.
No LLM_API_KEY → MOCK heuristics from the same facts (UI works offline).

Env: LLM_API_KEY, LLM_BASE_URL (default OpenAI), LLM_MODEL, LLM_VOTES (1), LLM_TEMPERATURE (0),
     LLM_PRICE_IN / LLM_PRICE_OUT (USD per 1M tokens, for the cost estimate).
Prompt texts are shared with the JS reference: /prompts/*.md.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .facts import extract_facts, facts_text
from .sanitize import sanitize

PROMPT_VERSION = "2026-11-07.3"
_PROMPTS = Path(__file__).resolve().parents[2] / "prompts"
PROMPT = {k: (_PROMPTS / f).read_text(encoding="utf-8") for k, f in
          {"system": "judge_system.md", "call": "call_rules.md", "guidance": "guidance.md"}.items()}


def numbered(transcript: list[dict]) -> str:
    return "\n".join(f"[{i}] {t.get('timestamp')} {str(t.get('speaker')).upper()}: {t.get('text')}" for i, t in enumerate(transcript))


def examples_text(examples: list[dict] | None) -> str:
    """Few-shot calibration from team reference labels of OTHER dialogs: [{"conv": {...}, "gold": {criterion_id: value}}]."""
    if not examples:
        return ""
    parts = []
    for k, e in enumerate(examples):
        tr = e["conv"]["transcript"]
        if len(tr) > 40:
            tr = tr[:40] + [{"timestamp": "…", "speaker": "system", "text": f"(ещё {len(e['conv']['transcript']) - 40} реплик)"}]
        parts.append(f"--- Пример {k + 1} ({e['conv'].get('channel')}, {e['conv'].get('language')}) ---\n{numbered(tr)}\n"
                     f"Эталон: {json.dumps(e['gold'], ensure_ascii=False, separators=(',', ':'))}")
    return "ПРИМЕРЫ ЭТАЛОННОЙ РАЗМЕТКИ (команда QA, другие диалоги):\n" + "\n\n".join(parts) + "\n\n"


def build_prompt(conv: dict, checklist: dict, facts: dict | None = None, examples: list[dict] | None = None) -> dict:
    facts = facts or extract_facts(conv)
    crit = []
    for c in checklist["criteria"]:
        d = {"id": c["id"], "name": c["text"], "rule_yes": c.get("description") or None, "type": c["type"]}
        if c["type"] == "scale":
            d["allowed_scores"] = c["scale"].get("steps") or f"integer {c['scale']['min']}..{c['scale']['max']}"
        d["na_allowed"] = bool(c.get("na_allowed"))
        if c.get("na_allowed") and c.get("na_rule"):
            d["na_condition"] = c["na_rule"]
        if c.get("critical_on") == "yes":
            d["yes_means_violation"] = True
        crit.append({k: v for k, v in d.items() if v is not None})
    is_call = conv.get("channel") == "voice call"
    system = (PROMPT["system"]
              .replace("{{CALL_RULES}}", PROMPT["call"] if is_call else "")
              .replace("{{GUIDANCE}}", PROMPT["guidance"].replace("{{INSTRUCTIONS}}", checklist["instructions"]) if checklist.get("instructions") else ""))
    user = (f"{examples_text(examples)}ЧЕК-ЛИСТ:\n{json.dumps(crit, ensure_ascii=False, indent=1)}\n\nФАКТЫ:\n{facts_text(facts)}\n\n"
            f"ДИАЛОГ ({conv.get('channel')}, {conv.get('language')}):\n{numbered(conv['transcript'])}")
    return {"system": system, "user": user}


_JSON_MODE = {"on": os.getenv("LLM_JSON_MODE", "1") != "0"}


def extract_json(text: str) -> str:
    """Tolerates ```json fences and text around the object (providers without JSON mode)."""
    t = re.sub(r"```(json)?", "", text, flags=re.I).strip()
    a, b = t.find("{"), t.rfind("}")
    return t[a:b + 1] if a >= 0 and b > a else t


def _post(prompt: dict) -> dict:
    payload = {
        "model": os.getenv("LLM_MODEL", "gpt-4.1-mini"),
        "temperature": float(os.getenv("LLM_TEMPERATURE", "0")),
        "messages": [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": prompt["user"]}],
    }
    if _JSON_MODE["on"]:
        payload["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(f"{os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')}/chat/completions", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {os.getenv('LLM_API_KEY')}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def _call_once(prompt: dict) -> dict:
    try:
        j = _post(prompt)
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace")
        if e.code == 400 and _JSON_MODE["on"] and re.search("response_format|json", body, re.I):
            _JSON_MODE["on"] = False  # provider without JSON mode: rely on the prompt
            try:
                j = _post(prompt)
            except urllib.error.HTTPError as e2:
                raise RuntimeError(f"LLM {e2.code}: {e2.read()[:300]!r}") from e2
        else:
            raise RuntimeError(f"LLM {e.code}: {body}") from e
    text = (j.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    try:
        parsed = json.loads(extract_json(text))
    except json.JSONDecodeError as e:
        raise RuntimeError("LLM returned invalid JSON") from e
    return {"json": parsed, "text": text, "usage": j.get("usage") or {}}


def _call(prompt: dict) -> dict:
    for attempt in range(6):
        try:
            return _call_once(prompt)
        except (RuntimeError, urllib.error.URLError) as e:
            transient = re.search(r"LLM (429|5\d\d)|invalid JSON", str(e)) or isinstance(e, urllib.error.URLError)
            if attempt == 5 or not transient:
                raise
            time.sleep(min(30, 2 * 2 ** attempt))
    raise RuntimeError("unreachable")


def _one_run(conv: dict, checklist: dict, prompt: dict) -> dict:
    r = _call(prompt)
    results, problems = sanitize(conv, checklist, r["json"])
    usage, text, repaired = r["usage"], r["text"], bool(problems)
    if problems:
        r2 = _call({**prompt, "user": f"{prompt['user']}\n\nВ прошлом ответе были ошибки: {'; '.join(problems)}. Верни полный исправленный JSON."})
        usage = {"prompt_tokens": usage.get("prompt_tokens", 0) + r2["usage"].get("prompt_tokens", 0),
                 "completion_tokens": usage.get("completion_tokens", 0) + r2["usage"].get("completion_tokens", 0)}
        text = r2["text"]
        results, problems = sanitize(conv, checklist, r2["json"])
    return {"results": results, "problems": problems, "usage": usage, "raw": text, "repaired": repaired}


def vote(checklist: dict, runs: list[list[dict]]) -> list[dict]:
    """Majority per criterion; scale without a majority → median step; agreement share = confidence."""
    if len(runs) == 1:
        return runs[0]
    out = []
    for c in checklist["criteria"]:
        rs = [next(x for x in run if x["criterion_id"] == c["id"]) for run in runs]

        def key(r):
            return "na" if r["na"] else f"s{r['score']}" if c["type"] == "scale" else r["answer"]

        counts: dict[str, int] = {}
        for r in rs:
            counts[key(r)] = counts.get(key(r), 0) + 1
        best_k, best_n = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        if c["type"] == "scale" and best_n * 2 <= len(rs) and all(not r["na"] for r in rs):
            med = sorted(r["score"] for r in rs)[len(rs) // 2]
            best_k, best_n = f"s{med}", sum(1 for r in rs if r["score"] == med)
        pick = next(r for r in rs if key(r) == best_k)
        out.append({**pick, "confidence": round(best_n / len(rs), 2), "votes": [key(r) for r in rs]})
    return out


def evaluate(conv: dict, checklist: dict, examples: list[dict] | None = None) -> dict:
    facts = extract_facts(conv)
    if not os.getenv("LLM_API_KEY"):
        return {**_mock(conv, checklist, facts), "facts": facts, "model": "MOCK (без ключа модели)", "cost_usd": 0, "prompt_version": PROMPT_VERSION}
    prompt = build_prompt(conv, checklist, facts, examples)
    n = max(1, int(os.getenv("LLM_VOTES", "1")))
    with ThreadPoolExecutor(max_workers=n) as ex:
        runs = list(ex.map(lambda _: _one_run(conv, checklist, prompt), range(n)))
    usage = {"prompt_tokens": sum(r["usage"].get("prompt_tokens", 0) for r in runs),
             "completion_tokens": sum(r["usage"].get("completion_tokens", 0) for r in runs)}
    cost = (usage["prompt_tokens"] * float(os.getenv("LLM_PRICE_IN", "0")) + usage["completion_tokens"] * float(os.getenv("LLM_PRICE_OUT", "0"))) / 1e6
    return {
        "results": vote(checklist, [r["results"] for r in runs]),
        "problems": [p for r in runs for p in r["problems"]],
        "facts": facts, "model": os.getenv("LLM_MODEL", "gpt-4.1-mini"), "votes": n, "usage": usage, "cost_usd": round(cost, 5),
        "prompt_version": PROMPT_VERSION, "examples": [e["conv"]["conversation_id"] for e in (examples or [])],
        "trace": {"system": prompt["system"], "user": prompt["user"], "raw": [r["raw"] for r in runs], "repaired": any(r["repaired"] for r in runs)},
    }


def _mock(conv: dict, checklist: dict, f: dict) -> dict:
    ops = [{**t, "i": i} for i, t in enumerate(conv["transcript"]) if t.get("speaker") == "operator"]
    span = f"{ops[0]['i']}-{ops[-1]['i']}" if ops else ""

    def pas(c, ok):
        return {"score": c["scale"]["max"] if ok else c["scale"]["min"]} if c["type"] == "scale" else {"answer": "yes" if ok else "no"}

    results = []
    for c in checklist["criteria"]:
        base = {"criterion_id": c["id"], "na": False, "na_reason": "", "evidence_ids": [], "checked_span": "", "explanation": "", "confidence": None}
        cid = c["id"]
        if not ops:
            r = {**base, "na": True, "na_reason": "Оператор не подключался к диалогу."} if c.get("na_allowed") else {**base, **pas(c, False), "checked_span": f"0-{len(conv['transcript']) - 1}", "explanation": "Реплик оператора нет."}
        elif re.search("contact|greeting", cid):
            ok = bool(f["first_reply_has_greeting"] and f["first_reply_has_introduction"] and (not f["client_language"] or f["first_reply_language"] == f["client_language"]))
            r = {**base, **pas(c, ok), "evidence_ids": [f["first_operator_idx"]], "explanation": "Оператор поздоровался на языке клиента и представился в первом ответе." if ok else "В первом ответе нет приветствия, имени или он не на языке клиента."}
        elif "identification" in cid:
            r = {**base, "answer": "yes", "evidence_ids": [f["events"]["identity_verified"]], "explanation": "Есть системное подтверждение личности."} if f["events"]["identity_verified"] >= 0 else {**base, "na": True, "na_reason": "MOCK: проверка личности не требовалась (нет защищённого действия)."}
        elif "closing" in cid:
            if f["ended_by"] == "connection_lost":
                r = {**base, "na": True, "na_reason": "Связь оборвалась до завершения."}
            else:
                ok = f["farewell_idx"] is not None
                r = {**base, **pas(c, ok), "evidence_ids": [f["farewell_idx"]] if ok else [f["last_operator_idx"]], "checked_span": "" if ok else span, "explanation": "Оператор попрощался." if ok else "Прощания не найдено."}
        elif "management" in cid and any(not w["warned"] for w in f["long_waits"]):
            r = {**base, "score": 7, "evidence_ids": [f["long_waits"][0]["to"]], "explanation": "Пауза более 3 минут без предупреждения."}
        elif c.get("critical_on") == "yes":
            r = ({**base, "answer": "yes", "evidence_ids": [h["idx"] for h in f["gross_hints"]], "explanation": "Найдено: " + ", ".join(h["kind"] for h in f["gross_hints"]) + "."}
                 if f["gross_hints"] else {**base, "answer": "no", "checked_span": span, "explanation": "MOCK: нарушений не найдено."})
        elif c.get("na_allowed"):
            r = {**base, "na": True, "na_reason": "MOCK: условие N/A (заглушка до подключения модели)."}
        else:
            r = {**base, **pas(c, True), "evidence_ids": [ops[-1]["i"]], "explanation": "MOCK: оценка-заглушка, подключите LLM_API_KEY."}
        results.append(r)
    return {"results": results, "problems": []}
