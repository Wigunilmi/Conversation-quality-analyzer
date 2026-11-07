"""Deterministic facts extracted from a transcript before the LLM runs — port of lib/facts.mjs.

Facts are hints for the model (it still decides) and are shown in the UI ("Как решила модель").
Parity with the JS version is checked by tests/test_facts.py against test/fixtures/facts.json.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

I = re.IGNORECASE
KZ_LETTERS = re.compile(r"[әғқңөұүһі]", I)
CYR_ANY = re.compile(r"[а-яёәғқңөұүһі]", I)
LAT_ANY = re.compile(r"[a-z]", I)

RE = {
    "greet": re.compile(r"здравствуй|привет|добр(ый|ое|ого) (день|утро|вечер)|приветствую|сәлем|қайырлы|hello|hi(?![a-z0-9_])|good (morning|afternoon|evening)|greetings", I),
    "intro": re.compile(r"меня зовут|на связи|с вами (говорит|на связи)|менің атым|атым\s|my name is|this is [A-ZА-Я]|\[имя скрыто\]|\[name hidden\]", I),
    "farewell": re.compile(r"до свидания|всего доброго|хорошего (дня|вечера)|всего хорошего|сау болыңыз|жақсы күн|қош бол|goodbye|bye(?![a-z0-9_])|have a (nice|good|great)", I),
    "moreHelp": re.compile(r"(что|чем)[- ]?(то|нибудь)? ещё|остались (ли )?вопросы|могу (ли )?(ещё )?чем|тағы (сұрақ|көмек)|басқа сұра|anything else|any other questions|further help", I),
    "waitWarn": re.compile(r"минут|ожида|подожд|секунд|уточн|провер|күте|тексер|нақтыла|wait|moment|hold on|let me check|one sec", I),
    "identityOk": re.compile(r"личность.*подтвержд|верифицирован|жеке бас.*раст|identity (is )?verified|verified the (customer|client)", I),
    "escalation": re.compile(r"эскалац|оператор(а|у)? (подключ|переведен)|чат операторға|transferred to an agent|агент присоединился|connected to an agent", I),
    "operatorClosed": re.compile(r"оператор закрыл|оператор чатты жапты|agent closed", I),
    "clientLeft": re.compile(r"клиент (завершил|покинул)|клиент чаттан шықты|customer (left|ended)", I),
    "connLost": re.compile(r"соединение.*прерван|байланыс үзілді|connection.*lost", I),
    "recStart": re.compile(r"запись и транскрибирование запущены|жазу және транскрипция басталды|recording.*started", I),
    "hold": re.compile(r"на удержании|hold", I),
}
GROSS = [
    ("предложение в обход компании", re.compile(
        r"(?:^|[\s,.])(?:на )?(?:мою|мой) (?:карт|счёт|счет)|(скиньте|переведите|отправьте|перекиньте)[^.!?]{0,25}(мне|лично)|я лично (предлага|переве|влож)|сам их влож|личн\S* номер|частн\S* консультац|за (отдельную )?плату|send me (your|the) (money|personal)|personal (phone )?number|to my (card|account)|private (advice|consult)|charge for|жеке (нөмір|кеңес)|маған (аударыңыз|жіберіңіз|салыңыз)|ақылы кеңес", I)),
    ("оскорбление", re.compile(r"(?:^|[\s,.!?«\"])(дура[кч]?|идиот|тупо[йг]|бестолоч|кретин|заткнись|stupid|idiot|shut up|ақымақ)", I)),
]
INTRO_NAME = re.compile(r"(^|[\s,.!])([ЯяМм]ен|[Яя]|I'?m|I am|It's)\s+[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+")
MMSS = re.compile(r"^\d+:\d{2}(:\d{2})?$")


NAME_RE = re.compile(r"(?:меня зовут|менің атым|my name is|(?:^|[\s,.!])(?:[Яя]|[Мм]ен|I'?m|I am|It's))\s+([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+)")
NOT_NAMES = {"Рад", "Сейчас", "Понимаю", "Вижу", "Уточню", "Here", "Sorry", "Happy", "Glad"}


def operator_name(text: str = "") -> str | None:
    """Operator name from the introduction (per-operator analytics). Masked names stay None."""
    m = NAME_RE.search(text or "")
    if not m or m.group(1) in NOT_NAMES:
        return None
    return re.sub(r"(ым|ім|мын|мін|пын|пін)$", "", m.group(1)) or m.group(1)


def has_intro(t: str) -> bool:
    return bool(RE["intro"].search(t) or INTRO_NAME.search(t))


def detect_lang(text: str = "") -> str | None:
    t = re.sub(r"\[[^\]]*\]", "", text or "")
    if KZ_LETTERS.search(t):
        return "KZ"
    c, l = len(CYR_ANY.findall(t)), len(LAT_ANY.findall(t))
    if not c and not l:
        return None
    return "RU" if c >= l else "EN"


def _parse_iso_ms(ts: str) -> float | None:
    """Epoch seconds truncated to milliseconds, like JS Date.parse."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$", ts.strip())
    if not m:
        return None
    frac = (m.group(2) or ".0")[1:4].ljust(3, "0")
    tz = m.group(3) or "+00:00"
    tz = "+00:00" if tz == "Z" else tz
    dt = datetime.fromisoformat(f"{m.group(1)}.{frac}{tz}")
    return round(dt.timestamp() * 1000) / 1000


def to_sec(ts: str | None, t0: str | None = None) -> float | None:
    if not ts:
        return None
    if MMSS.match(ts):
        total = 0
        for p in ts.split(":"):
            total = total * 60 + int(p)
        return total
    d = _parse_iso_ms(ts)
    if d is None:
        return None
    if t0 is None:
        return d
    d0 = _parse_iso_ms(t0)
    return d - d0 if d0 is not None else None


def _js_round(x: float) -> int:
    import math
    return math.floor(x + 0.5)


def _mode(arr: list) -> Any:
    counts: dict = {}
    for x in arr:
        counts[x] = counts.get(x, 0) + 1
    if not counts:
        return None
    best = max(counts.values())
    return next(k for k, v in counts.items() if v == best)  # first inserted among ties (JS stable sort)


def extract_facts(conv: dict) -> dict:
    tr = conv.get("transcript") or []
    t0 = tr[0].get("timestamp") if tr else None
    iso = bool(t0) and not re.match(r"^\d+:\d{2}", t0)

    def sec(i: int) -> int | None:
        if i is None or i < 0 or i >= len(tr):
            return None
        s = to_sec(tr[i].get("timestamp"), t0 if iso else None)
        return None if s is None else _js_round(s)

    def idx(pred) -> int:
        return next((i for i, t in enumerate(tr) if pred(t)), -1)

    ops = [{**t, "i": i} for i, t in enumerate(tr) if t.get("speaker") == "operator"]
    clients = [{**t, "i": i} for i, t in enumerate(tr) if t.get("speaker") == "client"]

    client_lang = _mode([l for l in (detect_lang(c["text"]) for c in clients) if l]) or conv.get("language")
    first_op = ops[0] if ops else None
    escalation_idx = idx(lambda t: t.get("speaker") == "system" and RE["escalation"].search(t["text"]))
    start_idx = escalation_idx if escalation_idx >= 0 else (clients[0]["i"] if clients else 0)
    first_delay = None
    if first_op and sec(first_op["i"]) is not None and sec(start_idx) is not None:
        first_delay = sec(first_op["i"]) - sec(start_idx)

    long_waits = []
    for k, op in enumerate(ops):
        if k == 0:
            continue
        prev_client = next((c for c in reversed(clients) if c["i"] < op["i"] and c["i"] > ops[k - 1]["i"]), None)
        if not prev_client:
            continue
        gap = sec(op["i"]) - sec(prev_client["i"])
        if gap > 180:
            warned = any(o["i"] > prev_client["i"] - 3 and RE["waitWarn"].search(o["text"]) for o in ops[:k]) or bool(RE["waitWarn"].search(ops[k - 1]["text"] or ""))
            long_waits.append({"from": prev_client["i"], "to": op["i"], "seconds": gap, "warned": warned})

    def sysi(key: str) -> int:
        return idx(lambda t: t.get("speaker") == "system" and RE[key].search(t["text"]))

    events = {
        "escalation": escalation_idx,
        "identity_verified": sysi("identityOk"),
        "operator_closed": sysi("operatorClosed"),
        "client_left": sysi("clientLeft"),
        "connection_lost": sysi("connLost"),
        "recording_started": sysi("recStart"),
        "hold": sysi("hold"),
    }
    end_idx = max(events["operator_closed"], events["client_left"], events["connection_lost"])
    gross_hints = [{"idx": o["i"], "kind": kind} for o in ops for kind, rx in GROSS if rx.search(o["text"])]
    last_op = ops[-1] if ops else None

    ended_by = None
    if end_idx >= 0:
        ended_by = "connection_lost" if end_idx == events["connection_lost"] else "client" if end_idx == events["client_left"] else "operator"

    return {
        "gross_hints": gross_hints,
        "channel": conv.get("channel"),
        "lines": len(tr),
        "operator_lines": len(ops),
        "client_language": client_lang,
        "operator_language": _mode([l for l in (detect_lang(o["text"]) for o in ops) if l]),
        "first_operator_idx": first_op["i"] if first_op else None,
        "first_operator_delay_sec": first_delay,
        "first_reply_over_3min": None if first_delay is None else first_delay > 180,
        "first_reply_has_greeting": bool(RE["greet"].search(first_op["text"])) if first_op else None,
        "first_reply_has_introduction": has_intro(first_op["text"]) if first_op else None,
        "first_reply_language": detect_lang(first_op["text"]) if first_op else None,
        "operator_name": next((n for n in (operator_name(o["text"]) for o in ops) if n), None),
        "long_waits": long_waits,
        "last_operator_idx": last_op["i"] if last_op else None,
        "farewell_idx": next((o["i"] for o in ops if RE["farewell"].search(o["text"])), None),
        "more_help_offer_idx": next((o["i"] for o in ops if RE["moreHelp"].search(o["text"])), None),
        "events": events,
        "ended_by": ended_by,
        "lines_after_last_operator": len([t for t in tr[last_op["i"] + 1:] if t.get("speaker") == "client"]) if last_op else None,
        "audio_offset_base_idx": events["recording_started"] if events["recording_started"] >= 0 else 0,
    }


def _yn(b) -> str:
    return "?" if b is None else "да" if b else "нет"


def facts_text(f: dict) -> str:
    e = f["events"]

    def at(i):
        return f"[{i}]" if i is not None and i >= 0 else "нет"

    lines = [f"Канал: {f['channel']}. Язык клиента (по тексту): {f['client_language'] or '?'}; язык оператора: {f['operator_language'] or '?'}."]
    if f["first_operator_idx"] is None:
        lines.append("Оператор в диалоге НЕ писал.")
    else:
        d = f["first_operator_delay_sec"]
        lines.append(f"Первая реплика оператора: [{f['first_operator_idx']}], через {d if d is not None else '?'} с после эскалации/запроса"
                     f"{' (ДОЛЬШЕ порога 3 мин)' if f['first_reply_over_3min'] else ''}; приветствие: {_yn(f['first_reply_has_greeting'])}, "
                     f"представился: {_yn(f['first_reply_has_introduction'])}, язык: {f['first_reply_language'] or '?'}.")
    lines.append(f"Системные события: эскалация {at(e['escalation'])}, личность подтверждена {at(e['identity_verified'])}, оператор закрыл {at(e['operator_closed'])}, "
                 f"клиент ушёл {at(e['client_left'])}, обрыв связи {at(e['connection_lost'])}, удержание {at(e['hold'])}.")
    if f["long_waits"]:
        lines.append("Паузы оператора > 3 мин: " + "; ".join(f"[{w['from']}]→[{w['to']}] {_js_round(w['seconds'] / 60)} мин, предупреждение: {_yn(w['warned'])}" for w in f["long_waits"]) + ".")
    else:
        lines.append("Пауз оператора больше 3 минут нет.")
    if f["gross_hints"]:
        lines.append("ВОЗМОЖНЫЕ грубые нарушения (проверь!): " + "; ".join(f"[{h['idx']}] {h['kind']}" for h in f["gross_hints"]) + ".")
    else:
        lines.append("Явных маркеров грубых нарушений код не нашёл (это не гарантия — проверь сам).")
    lines.append(f"Прощание оператора: {at(f['farewell_idx'])}; предложение доп. помощи: {at(f['more_help_offer_idx'])}; последняя реплика оператора: {at(f['last_operator_idx'])}; диалог завершил: {f['ended_by'] or 'не указано'}.")
    return "\n".join(lines)
