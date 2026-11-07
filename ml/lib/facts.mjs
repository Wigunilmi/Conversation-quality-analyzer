// Deterministic facts extracted from a transcript BEFORE the LLM runs.
// They are given to the model as hints (it still decides), and shown in the UI as "what the code saw".
// Regexes cover RU / KZ / EN, the three languages of the dataset.

const KZ_LETTERS = /[әғқңөұүһі]/i;

export function detectLang(text = "") {
  const t = text.replace(/\[[^\]]*\]/g, "");
  if (KZ_LETTERS.test(t)) return "KZ";
  const c = (t.match(/[а-яёәғқңөұүһі]/gi) || []).length, l = (t.match(/[a-z]/gi) || []).length;
  if (!c && !l) return null;
  return c >= l ? "RU" : "EN";
}

const RE = {
  greet: /здравствуй|привет|добр(ый|ое|ого) (день|утро|вечер)|приветствую|сәлем|қайырлы|hello|hi\b|good (morning|afternoon|evening)|greetings/i,
  intro: /меня зовут|на связи|с вами (говорит|на связи)|менің атым|атым\s|my name is|this is [A-ZА-Я]|\[имя скрыто\]|\[name hidden\]/i,
  farewell: /до свидания|всего доброго|хорошего (дня|вечера)|всего хорошего|сау болыңыз|жақсы күн|қош бол|goodbye|bye\b|have a (nice|good|great)/i,
  moreHelp: /(что|чем)[- ]?(то|нибудь)? ещё|остались (ли )?вопросы|могу (ли )?(ещё )?чем|тағы (сұрақ|көмек)|басқа сұра|anything else|any other questions|further help/i,
  waitWarn: /минут|ожида|подожд|секунд|уточн|провер|күте|тексер|нақтыла|wait|moment|hold on|let me check|one sec/i,
  identityOk: /личность.*подтвержд|верифицирован|жеке бас.*раст|identity (is )?verified|verified the (customer|client)/i,
  escalation: /эскалац|оператор(а|у)? (подключ|переведен)|чат операторға|transferred to an agent|агент присоединился|connected to an agent/i,
  operatorClosed: /оператор закрыл|оператор чатты жапты|agent closed/i,
  clientLeft: /клиент (завершил|покинул)|клиент чаттан шықты|customer (left|ended)/i,
  connLost: /соединение.*прерван|байланыс үзілді|connection.*lost/i,
  recStart: /запись и транскрибирование запущены|жазу және транскрипция басталды|recording.*started/i,
  hold: /на удержании|hold/i,
};
// Gross-error red flags (hints only; the model confirms).
const GROSS = [
  ["предложение в обход компании", /(?:^|[\s,.])(?:на )?(?:мою|мой) (?:карт|счёт|счет)|(скиньте|переведите|отправьте|перекиньте)[^.!?]{0,25}(мне|лично)|я лично (предлага|переве|влож)|сам их влож|личн\S* номер|частн\S* консультац|за (отдельную )?плату|send me (your|the) (money|personal)|personal (phone )?number|to my (card|account)|private (advice|consult)|charge for|жеке (нөмір|кеңес)|маған (аударыңыз|жіберіңіз|салыңыз)|ақылы кеңес/i],
  ["оскорбление", /(?:^|[\s,.!?«"])(дура[кч]?|идиот|тупо[йг]|бестолоч|кретин|заткнись|stupid|idiot|shut up|ақымақ)/i],
];
// "я Тимур", "Я Лера", "Мен Аружан", "I'm Anna" — case-sensitive on the name.
const INTRO_NAME = /(^|[\s,.!])([ЯяМм]ен|[Яя]|I'?m|I am|It's)\s+[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+/;
const hasIntro = (t) => RE.intro.test(t) || INTRO_NAME.test(t);
// Operator name from the introduction (for per-operator analytics). Masked names stay null.
const NAME_RE = /(?:меня зовут|менің атым|my name is|(?:^|[\s,.!])(?:[Яя]|[Мм]ен|I'?m|I am|It's))\s+([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+)/;
const NOT_NAMES = new Set(["Рад", "Сейчас", "Понимаю", "Вижу", "Уточню", "Here", "Sorry", "Happy", "Glad"]);
export function operatorName(text = "") {
  const m = text.match(NAME_RE);
  if (!m || NOT_NAMES.has(m[1])) return null;
  return m[1].replace(/(ым|ім|мын|мін|пын|пін)$/u, "") || m[1]; // "Айданамын" → "Айдана"
}

export function toSec(ts, t0) {
  if (!ts) return null;
  if (/^\d+:\d{2}(:\d{2})?$/.test(ts)) return ts.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  const d = Date.parse(ts);
  if (Number.isNaN(d)) return null;
  return t0 === undefined ? d / 1000 : (d - Date.parse(t0)) / 1000;
}

export function extractFacts(conv) {
  const tr = conv.transcript || [];
  const t0 = tr[0]?.timestamp;
  const iso = t0 && !/^\d+:\d{2}/.test(t0);
  const sec = (i) => { const s = toSec(tr[i]?.timestamp, iso ? t0 : undefined); return s === null ? null : Math.round(s); };
  const idx = (pred) => tr.findIndex(pred);
  const ops = tr.map((t, i) => ({ ...t, i })).filter((t) => t.speaker === "operator");
  const clients = tr.map((t, i) => ({ ...t, i })).filter((t) => t.speaker === "client");

  const clientLang = mode(clients.map((c) => detectLang(c.text)).filter(Boolean)) || conv.language || null;
  const firstOp = ops[0];
  const escalationIdx = idx((t) => t.speaker === "system" && RE.escalation.test(t.text));
  const startIdx = escalationIdx >= 0 ? escalationIdx : clients[0]?.i ?? 0;
  const firstOpDelay = firstOp && sec(firstOp.i) !== null && sec(startIdx) !== null ? sec(firstOp.i) - sec(startIdx) : null;

  // Long silences: a client line followed by the next operator line more than 180 s later.
  const longWaits = [];
  for (let k = 0; k < ops.length; k++) {
    const prevClient = [...clients].reverse().find((c) => c.i < ops[k].i && (k === 0 || c.i > ops[k - 1].i));
    if (!prevClient || k === 0) continue;
    const gap = sec(ops[k].i) - sec(prevClient.i);
    if (gap > 180) {
      const warned = ops.slice(0, k).some((o) => o.i > prevClient.i - 3 && RE.waitWarn.test(o.text)) || RE.waitWarn.test(ops[k - 1]?.text || "");
      longWaits.push({ from: prevClient.i, to: ops[k].i, seconds: gap, warned });
    }
  }

  const lastOp = ops.at(-1);
  const sys = (re) => idx((t) => t.speaker === "system" && re.test(t.text));
  const events = {
    escalation: escalationIdx,
    identity_verified: sys(RE.identityOk),
    operator_closed: sys(RE.operatorClosed),
    client_left: sys(RE.clientLeft),
    connection_lost: sys(RE.connLost),
    recording_started: sys(RE.recStart),
    hold: sys(RE.hold),
  };
  const endIdx = Math.max(events.operator_closed, events.client_left, events.connection_lost);

  const gross_hints = [];
  ops.forEach((o) => GROSS.forEach(([kind, re]) => { if (re.test(o.text)) gross_hints.push({ idx: o.i, kind }); }));
  return {
    gross_hints,
    channel: conv.channel,
    lines: tr.length,
    operator_lines: ops.length,
    client_language: clientLang,
    operator_language: mode(ops.map((o) => detectLang(o.text)).filter(Boolean)),
    first_operator_idx: firstOp?.i ?? null,
    first_operator_delay_sec: firstOpDelay,
    first_reply_over_3min: firstOpDelay === null ? null : firstOpDelay > 180,
    first_reply_has_greeting: firstOp ? RE.greet.test(firstOp.text) : null,
    first_reply_has_introduction: firstOp ? hasIntro(firstOp.text) : null,
    first_reply_language: firstOp ? detectLang(firstOp.text) : null,
    operator_name: ops.map((o) => operatorName(o.text)).find(Boolean) || null,
    long_waits: longWaits,
    last_operator_idx: lastOp?.i ?? null,
    farewell_idx: ops.find((o) => RE.farewell.test(o.text))?.i ?? null,
    more_help_offer_idx: ops.find((o) => RE.moreHelp.test(o.text))?.i ?? null,
    events,
    ended_by: endIdx < 0 ? null : endIdx === events.connection_lost ? "connection_lost" : endIdx === events.client_left ? "client" : "operator",
    lines_after_last_operator: lastOp ? tr.slice(lastOp.i + 1).filter((t) => t.speaker === "client").length : null,
    audio_offset_base_idx: events.recording_started >= 0 ? events.recording_started : 0,
  };
}

// Human-readable bullet list for the prompt.
export function factsText(f) {
  const e = f.events, at = (i) => (i !== null && i !== undefined && i >= 0 ? `[${i}]` : "нет");
  return [
    `Канал: ${f.channel}. Язык клиента (по тексту): ${f.client_language || "?"}; язык оператора: ${f.operator_language || "?"}.`,
    f.first_operator_idx === null ? "Оператор в диалоге НЕ писал." : `Первая реплика оператора: [${f.first_operator_idx}], через ${f.first_operator_delay_sec ?? "?"} с после эскалации/запроса${f.first_reply_over_3min ? " (ДОЛЬШЕ порога 3 мин)" : ""}; приветствие: ${yn(f.first_reply_has_greeting)}, представился: ${yn(f.first_reply_has_introduction)}, язык: ${f.first_reply_language || "?"}.`,
    `Системные события: эскалация ${at(e.escalation)}, личность подтверждена ${at(e.identity_verified)}, оператор закрыл ${at(e.operator_closed)}, клиент ушёл ${at(e.client_left)}, обрыв связи ${at(e.connection_lost)}, удержание ${at(e.hold)}.`,
    f.long_waits.length ? `Паузы оператора > 3 мин: ${f.long_waits.map((w) => `[${w.from}]→[${w.to}] ${Math.round(w.seconds / 60)} мин, предупреждение: ${yn(w.warned)}`).join("; ")}.` : "Пауз оператора больше 3 минут нет.",
    f.gross_hints.length ? `ВОЗМОЖНЫЕ грубые нарушения (проверь!): ${f.gross_hints.map((h) => `[${h.idx}] ${h.kind}`).join("; ")}.` : "Явных маркеров грубых нарушений код не нашёл (это не гарантия — проверь сам).",
    `Прощание оператора: ${at(f.farewell_idx)}; предложение доп. помощи: ${at(f.more_help_offer_idx)}; последняя реплика оператора: ${at(f.last_operator_idx)}; диалог завершил: ${f.ended_by || "не указано"}.`,
  ].join("\n");
}

const yn = (b) => (b === null || b === undefined ? "?" : b ? "да" : "нет");
function mode(arr) {
  const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
