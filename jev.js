// jev.js — every Jev question + every threshold for Nice Chat lives here.
// Pattern: one fan-out batch per draft, atomic questions, code decides.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL || "jev-latest";

// ---------------------------------------------------------------- questions
const QUESTIONS = {
  is_kind: {
    type: "noul",
    instructions: "Is `draft_message` kind, friendly or supportive toward the people in the chat?",
    criteria: {
      true: "Warm, encouraging, appreciative, helpful or gently neutral-friendly",
      false: "Not kind: cold, dismissive, mocking, rude or hostile",
    },
  },
  is_laughter: {
    type: "noul",
    instructions: "Is `draft_message` essentially just laughter or amusement — haha, lol, lmao, rofl, 😂, 'that's hilarious' — with no words aimed at a person?",
    criteria: {
      true: "Pure laughter/amusement in any casing or length: 'hahaha', 'LOL', 'lmaooo', 'haha nice', '😂😂'",
      false: "Contains an actual statement about someone, or laughter attached to a put-down: 'lol you're pathetic', 'haha nobody cares'",
    },
  },
  is_insult: {
    type: "noul",
    instructions: "Does `draft_message` insult, belittle or demean a person or group?",
    criteria: {
      true: "Name-calling, put-downs, 'you're dumb/useless', mocking someone's abilities or looks",
      false: "No insult present",
    },
  },
  is_sarcastic_or_backhanded: {
    type: "noul",
    instructions: "Is `draft_message` sarcastic, snarky or a backhanded compliment?",
    criteria: {
      true: "Says the opposite of what it means to mock, e.g. 'wow, great job genius', 'nice of you to finally show up'",
      false: "Sincere; means what it says",
    },
  },
  is_passive_aggressive: {
    type: "noul",
    instructions: "Is `draft_message` passive-aggressive: indirect hostility hidden behind polite or neutral words?",
    criteria: {
      true: "'Fine, whatever', 'per my last message', 'I guess some people just don't care', pointed sighs",
      false: "Direct and sincere, no hidden dig",
    },
  },
  is_negative: {
    type: "noul",
    instructions: "Is `draft_message` negative in spirit — complaining, venting, gloom, sad news, grief, disgust, boredom or declaring that something is bad, sucks or is a waste — even when nobody is attacked?",
    criteria: {
      true: "Downbeat, grumbling or sad with no upside: 'this sucks', 'I feel crappy today', 'ugh, what a waste of time', 'everything is terrible', 'so bored', 'I hate Mondays', 'worst day ever', 'my cat died today', 'my dog passed away', 'I lost my grandma this week'",
      false: "Upbeat, appreciative or plainly neutral: greetings, questions, facts, logistics, jokes, 'what time is it', 'I'm from Ohio', 'the demo starts at 3'; also a sad fact shared with warmth or hope ('rough day, but this room cheers me up')",
    },
  },
  is_profane_or_slur: {
    type: "noul",
    instructions: "Does `draft_message` contain profanity, obscenity or a slur?",
    criteria: {
      true: "Swear words, obscene language, slurs against any group (including masked spellings like f*ck)",
      false: "Clean language",
    },
  },
  is_disguised_slur: {
    type: "noul",
    instructions:
      "Decode any odd-looking token in `draft_message` — read digits and symbols as the letters they resemble (1/!=i, 3=e, 4/@=a, 0=o, 5/$=s, 7=t), drop spaces/dots/hyphens between letters, sound out homophones — does a single token, once decoded, spell a slur, swear word or hateful term? Innocent framing (a math problem, a variable name, a wifi/pet name, 'lol') does not make it fine. Ordinary short identifiers that don't decode to a word are fine.",
    criteria: {
      true: "One token decodes to a slur or obscenity: k1k3 -> kike, n1gg3r -> nigger, f@g, f a g, sh1t, b1tch, g4y used as a jeer",
      false: "No token decodes to a slur or swear: ordinary words, leetspeak of harmless words (gr8, l8r, y0u), separate math/code identifiers such as k1, k3, x2, n, real names or brands that merely look unusual",
    },
  },
  is_derogatory_label: {
    type: "noul",
    instructions:
      "Is `draft_message` using a word or phrase as a put-down, jeer or derogatory label for people — e.g. an identity term (gay, autistic), a stereotype nickname (karen, snowflake, boomer) or a diagnosis — including when the word is dropped on its own with no sincere context?",
    criteria: {
      true: "Bare or mocking use of a term that is used to demean people: 'gay', 'karen', 'snowflake', 'that's so autistic', with nothing making it sincere or supportive",
      false: "Sincere, descriptive or self-referential use ('I'm gay and proud', 'my friend is autistic'), or no such term at all",
    },
  },
  is_hateful: {
    type: "noul",
    instructions: "Does `draft_message` express contempt, a stereotype or exclusion toward people because of their sexuality, gender, race, religion, disability, age or nationality?",
    criteria: {
      true: "Bigoted generalisations, 'go back to your country', 'women can't code', dehumanising or mocking a group",
      false: "No group is targeted",
    },
  },
  is_harassment_or_threat: {
    type: "noul",
    instructions: "Does `draft_message` harass, intimidate or threaten anyone?",
    criteria: {
      true: "Threats of harm, 'I'll find you', intimidation, sexual harassment, telling someone to hurt themselves",
      false: "No harassment or threat",
    },
  },
  has_link: {
    type: "noul",
    instructions:
      "Is `draft_message` sharing or smuggling in a web address — a URL, domain, link, shortener, IP address or server to connect to, or a handle plus platform to contact — even when it is spelled out, spaced out or obfuscated ('example dot com', 'bit ly slash abc', 'discord gg / xyz', 'example [.] com', 'hxxp', 'w w w dot', letters separated by spaces or emojis)? Mentioning a well-known site as a plain noun in conversation does not count.",
    criteria: {
      true: "Anything a reader could type into a browser or use to reach the sender elsewhere: 'check out example dot com', 'bit(dot)ly/abc', 'my discord: discord gg slash nice', 'dm me on telegram @spamguy', 'e x a m p l e . c o m', 'my server is at 45.33.32.156', 'connect to 192.168.0.1 for the game', 'google \"cheap watches 4 u\" and click the first result'",
      false: "Talking about the web without pointing anywhere: 'I saw a cute dog on youtube', 'just google it', 'the internet is wild today'; also version numbers (2.0.1), times (5.30), decimals (3.14), abbreviations (e.g., U.S., Mr.)",
    },
  },
  tone: {
    type: "choice",
    instructions: "What is the overall tone of `draft_message` toward the people in the chat?",
    criteria: {
      warm: "Friendly, caring, positive",
      neutral: "Matter-of-fact, informational, neither warm nor cold",
      cold: "Curt, dismissive, distant, subtly negative",
      hostile: "Angry, aggressive, contemptuous, attacking",
    },
  },
  niceness: {
    type: "score",
    instructions: "How nice is `draft_message`, on a scale from 1 (mean) to 5 (delightfully kind)?",
    criteria: [
      "1 - Mean: hostile, insulting or cruel",
      "2 - Unkind: snarky, cold or dismissive",
      "3 - Neutral: plain and inoffensive",
      "4 - Nice: friendly and considerate",
      "5 - Delightful: warm, generous, uplifting",
    ],
  },
};

// A display name is shown next to every message the person sends, so it is judged on its own
// (no room context) with questions phrased for a name rather than a sentence.
const NAME_QUESTIONS = {
  name_is_profane_or_slur: {
    type: "noul",
    instructions:
      "Does `username` contain a swear word, obscenity or slur — including disguised ones? Decode digits and symbols as the letters they resemble (1/!=i, 3=e, 4/@=a, 0=o, 5/$=s, 7=t), ignore underscores, dots and spaces between letters, and sound out homophones.",
    criteria: {
      true: "'fuckface', 'sh1thead', 'k1k3', 'n1gz', 'b!tch_queen', 'f a g', 'phuck'",
      false: "Ordinary words and names, harmless leetspeak (gr8, l8r), identifiers like k1 or x2, real names that merely look unusual",
    },
  },
  name_is_derogatory: {
    type: "noul",
    instructions: "Does `username` insult, mock or demean a person or a group — a put-down, a jeer, or a stereotype label used as a name?",
    criteria: {
      true: "'ur_all_idiots', 'losers_everywhere', 'karen_slayer', 'jared_is_dumb', 'fat_people_lol', 'retard'",
      false: "Neutral, playful or self-deprecating-but-harmless names: 'sunny sam', 'cool_cat42', 'sleepy potato', 'nerd'",
    },
  },
  name_is_hateful: {
    type: "noul",
    instructions:
      "Does `username` reference hate, extremism or contempt for a group because of race, religion, sexuality, gender, disability, age or nationality — including coded references (hitler, kkk, 1488, 88, wpww, nazi imagery)?",
    criteria: {
      true: "'hitler_did_nothing', 'kkk_kid', 'adolf88', 'trans_are_gross', 'white_power'",
      false: "No group targeted; sincere or proud identity terms ('proud_trans_mom', 'gay_and_happy') are fine",
    },
  },
  name_is_sexual: {
    type: "noul",
    instructions: "Is `username` sexually explicit or crude?",
    criteria: {
      true: "Genital slang, sex acts, 'horny4u', 'big_d1ck_dan'",
      false: "Nothing sexual, or mild affectionate words like 'cutie' or 'sweetheart'",
    },
  },
  name_is_hostile: {
    type: "noul",
    instructions: "Is `username` hostile, threatening or meant to provoke or upset the people who will read it next to every message?",
    criteria: {
      true: "'kill_yourself', 'i_hate_you_all', 'your_mom_is_ugly', 'die_die_die', 'fight_me'",
      false: "Friendly, neutral, edgy-but-harmless ('darkstar', 'chaos_goblin', 'grumpy cat')",
    },
  },
  name_vibe: {
    type: "choice",
    instructions: "What vibe does `username` give off as a display name in a friendly chat room?",
    criteria: {
      positive: "Warm, playful, cute, cheerful or proud",
      neutral: "Plain: a first name, a handle, an object, an animal, letters and numbers",
      negative: "Mean-spirited, gross, creepy or aggressive",
    },
  },
};

// --------------------------------------------------------------- thresholds
// Cost of being wrong: blocking a kind message is annoying; letting a cruel
// one through breaks the promise of the room. So hard categories block at a
// fairly low probability, softer ones need more evidence.
const THRESHOLDS = {
  is_harassment_or_threat: 0.35,
  is_profane_or_slur: 0.4,
  is_disguised_slur: 0.4,
  is_hateful: 0.4,
  is_derogatory_label: 0.5,
  is_insult: 0.5,
  has_link: 0.5,
  is_sarcastic_or_backhanded: 0.6,
  is_passive_aggressive: 0.65,
  is_negative: 0.6, // complaining/venting/sad news is not mean, but it is not nice either
  hostile_tone_min_prob: 0.55, // tone == hostile with at least this probability
  cold_tone_min_prob: 0.75, // very confidently cold also blocks
  niceness_min: 2.5, // score below this blocks even if no flag fired
  kind_rescue: 0.85, // very kind + only soft flags -> let it through
  laughter_rescue: 0.7, // plain laughter is good: only slurs/profanity/hate/threats can still block it
  // names
  name_is_profane_or_slur: 0.4,
  name_is_hateful: 0.4,
  name_is_sexual: 0.5,
  name_is_derogatory: 0.5,
  name_is_hostile: 0.5,
  name_negative_vibe_min_prob: 0.6, // vibe == negative with at least this probability blocks on its own
};

const REASON_LABELS = {
  is_harassment_or_threat: "that reads as a threat",
  is_profane_or_slur: "watch the language",
  is_disguised_slur: "nice try hiding that",
  is_hateful: "no hate here",
  is_derogatory_label: "that word is used to put people down",
  is_insult: "that's an insult",
  has_link: "no links, please",
  is_sarcastic_or_backhanded: "sounds sarcastic",
  is_passive_aggressive: "a bit passive-aggressive",
  is_negative: "keep it positive",
  hostile: "hostile tone",
  cold: "pretty cold",
  low_niceness: "not quite nice enough",
  name_is_profane_or_slur: "no swears or slurs in a name",
  name_is_derogatory: "that name puts people down",
  name_is_hateful: "no hate here",
  name_is_sexual: "keep it PG",
  name_is_hostile: "that name sounds hostile",
  name_negative: "pick something friendlier",
};

const HARD_FLAGS = ["is_harassment_or_threat", "is_profane_or_slur", "is_disguised_slur", "is_hateful", "is_derogatory_label", "is_insult", "has_link"];
// Laughter after a mishap reads as mocking to Jev (cold tone, low niceness, faint insult); the room
// treats laughing as good, so only actual language violations survive the laughter rescue.
const LAUGHTER_CANT_SAVE = ["is_harassment_or_threat", "is_profane_or_slur", "is_disguised_slur", "is_hateful", "is_derogatory_label", "has_link"];

// ------------------------------------------------------------------- links
// Links are the spam vector, so anything that parses as an address is refused before Jev is even
// asked; Jev's `has_link` catches the spelled-out and creatively spaced forms this misses.
// TLDs that are not English words count on their own ("example.com"); word-like ones (me, us, free,
// live, ...) only count with a path, so "agree.me too" and "done.free pizza" pass but "t.me/spam"
// does not. A dot with a space after it is only collapsed before the handful of TLDs that never
// start a sentence ("example. com"), so "this. AI is cool" stays a sentence.
const CORE_TLDS =
  "com|net|org|io|ai|gg|xyz|ly|biz|info|tv|edu|gov|xxx|icu|ooo|fyi|vip|wtf|app|dev|tk|ml|ga|cf|gq|pw|ws|cc|co|uk|ru|cn|de|fr|jp|kr|br|mx|eu|ca|au|nl|se|ch|es|fm|im|la|nu|ee|sh|st|gd|gy|gl";
const SPACED_TLDS = "com|net|org|xyz|biz|edu|gov|xxx|icu|ooo";
const WORDY_TLDS =
  "me|us|to|in|is|it|be|no|so|am|at|on|or|an|as|by|do|if|my|up|go|id|link|click|site|online|shop|store|club|live|life|world|tech|fun|space|website|page|video|news|today|win|pro|lol|zip|mov|cash|money|bet|casino|porn|sex|buzz|monster|cloud|host|network|email|group|team|chat|social|stream|download|free|top|rest|bar|ink|one|run|surf|wiki|pics|cam|date|loan|men|party|review|trade|work|rocks|ninja|guru";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LINK_RES = [
  /(?:https?|ftps?|sftp|wss?|file):\/\/\S/, // any scheme
  /(?:^|[^a-z0-9])www\d?\.[a-z0-9]/, // www. without a scheme
  new RegExp(`(?:^|[^a-z0-9.])(?:${LABEL}\\.)+(?:${CORE_TLDS})(?![a-z0-9-])`),
  new RegExp(`(?:^|[^a-z0-9.])(?:${LABEL}\\.)+(?:${WORDY_TLDS})\\/[a-z0-9]`),
];
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Bare IPv4 with valid octets; a version like 1.2.3.4 is indistinguishable from an address, so it
// only counts with something that makes it navigable (a port, path or scheme handled above).
const IPV4_RE = new RegExp(`(?:^|[^0-9.])${OCTET}(?:\\.${OCTET}){3}(?::\\d{2,5}|\\/[a-z0-9])`);
const SPACED_DOT_RE = new RegExp(`(?<=[a-z0-9])\\s*\\.\\s+(?=(?:${SPACED_TLDS})(?![a-z0-9-]))`, "g");

// Undo the usual disguises so the regexes above see a plain address.
function normalizeForLinks(text) {
  return text
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "") // zero-width joiners hidden inside words
    .replace(/[\u3002\uff0e\u2024\u00b7\u2022]/g, ".") // 。 ． ․ · • stand-ins for a dot
    .replace(/h[x*]{2}ps?(?=\s*:)/g, "http") // hxxp://
    .replace(/\s*:\s*\/\s*\/\s*/g, "://") // http : / / example
    .replace(/(?<=[a-z0-9])\s*[\[\(\{<]\s*(?:d[o0]t|\.)\s*[\]\)\}>]\s*(?=[a-z0-9])/g, ".") // example[.]com, example (dot) com
    .replace(/(?<=[a-z0-9])\s+d[o0]t\s+(?=[a-z0-9])/g, ".") // example dot com
    .replace(/(?<=[a-z0-9])\s+(?:slash|\/)\s+(?=[a-z0-9])/g, "/") // bit.ly slash abc
    .replace(SPACED_DOT_RE, ".") // example . com / example. com
    .replace(/\.c[0o]m(?![a-z0-9])/g, ".com") // leet TLDs
    .replace(/\.[0o]rg(?![a-z0-9])/g, ".org")
    .replace(/\.n[3e]t(?![a-z0-9])/g, ".net");
}

function looksLikeLink(text) {
  const t = normalizeForLinks(text);
  return LINK_RES.some((re) => re.test(t)) || IPV4_RE.test(t);
}

// A link is spam, not cruelty: a firm but not furious wiggle.
const LINK_MEANNESS = 0.45;

// Verdict shape for a draft refused on sight, so the UI treats it exactly like a Jev block.
function linkVerdict() {
  return {
    allowed: false,
    reasons: [REASON_LABELS.has_link],
    hits: ["has_link"],
    niceness: null,
    tone: null,
    tone_probs: null,
    niceness_probs: null,
    kind: null,
    meanness: LINK_MEANNESS,
    flags: { has_link: 1 },
    latency_ms: 0,
    cached: false,
    skipped: false,
    local: true, // decided here, not by Jev: callers keep it out of Jev request/latency stats
  };
}

// ------------------------------------------------------------------ decide
function decide(answers) {
  const reasons = [];
  const flags = {};
  for (const id of Object.keys(QUESTIONS)) {
    if (QUESTIONS[id].type !== "noul") continue;
    const p = answers[id]?.noul ?? 0;
    flags[id] = Math.round(p * 1000) / 1000;
    if (THRESHOLDS[id] != null && p >= THRESHOLDS[id]) reasons.push({ id, label: REASON_LABELS[id], p });
  }

  const tone = answers.tone?.choice ?? "neutral";
  const toneProbs = answers.tone?.probabilities ?? {};
  const toneProb = toneProbs[tone] ?? 0;
  if (tone === "hostile" && toneProb >= THRESHOLDS.hostile_tone_min_prob) {
    reasons.push({ id: "hostile", label: REASON_LABELS.hostile, p: toneProb });
  } else if (tone === "cold" && toneProb >= THRESHOLDS.cold_tone_min_prob) {
    reasons.push({ id: "cold", label: REASON_LABELS.cold, p: toneProb });
  }

  // Score levels come back 0-indexed (legend "0".."4"); shift to the 1–5 scale.
  const niceness = (answers.niceness?.score ?? 2) + 1;
  const kind = answers.is_kind?.noul ?? 0;

  const laughter = answers.is_laughter?.noul ?? 0;
  const laughing = laughter >= THRESHOLDS.laughter_rescue && !reasons.some((r) => LAUGHTER_CANT_SAVE.includes(r.id));

  const hardHit = reasons.some((r) => HARD_FLAGS.includes(r.id) || r.id === "hostile");
  if (laughing || (!hardHit && kind >= THRESHOLDS.kind_rescue)) {
    // Plain laughter, or a very kind message with only soft flags: let it through.
    reasons.length = 0;
  }
  if (reasons.length === 0 && !laughing && niceness < THRESHOLDS.niceness_min) {
    reasons.push({ id: "low_niceness", label: REASON_LABELS.low_niceness, p: 1 - niceness / 5 });
  }

  // meanness 0..1 drives the UI wiggle: how hard should the Send button protest?
  const meanness = Math.max(
    (3 - niceness) / 2, // 1 -> 1.0, 3+ -> 0
    flags.is_harassment_or_threat ?? 0,
    flags.is_insult ?? 0,
    flags.is_profane_or_slur ?? 0,
    flags.is_disguised_slur ?? 0,
    flags.is_hateful ?? 0,
    flags.is_derogatory_label ?? 0,
    toneProbs.hostile ?? 0,
    0.8 * (flags.is_sarcastic_or_backhanded ?? 0),
    0.7 * (flags.is_passive_aggressive ?? 0),
    0.35 * (flags.is_negative ?? 0),
    (flags.has_link ?? 0) >= THRESHOLDS.has_link ? LINK_MEANNESS : 0
  );

  reasons.sort((a, b) => b.p - a.p);
  return {
    allowed: reasons.length === 0,
    reasons: reasons.slice(0, 3).map((r) => r.label),
    hits: reasons.map((r) => r.id),
    niceness: Math.round(niceness * 10) / 10,
    tone,
    tone_probs: Object.fromEntries(Object.entries(toneProbs).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    niceness_probs: answers.niceness?.probabilities
      ? Object.fromEntries(Object.entries(answers.niceness.probabilities).map(([k, v]) => [String(Number(k) + 1), Math.round(v * 1000) / 1000]))
      : null,
    kind: Math.round(kind * 1000) / 1000,
    meanness: Math.round(Math.min(1, Math.max(0, meanness)) * 100) / 100,
    flags,
  };
}

function decideName(answers) {
  const reasons = [];
  const flags = {};
  for (const id of Object.keys(NAME_QUESTIONS)) {
    if (NAME_QUESTIONS[id].type !== "noul") continue;
    const p = answers[id]?.noul ?? 0;
    flags[id] = Math.round(p * 1000) / 1000;
    if (p >= THRESHOLDS[id]) reasons.push({ id, label: REASON_LABELS[id], p });
  }
  const vibe = answers.name_vibe?.choice ?? "neutral";
  const vibeProbs = answers.name_vibe?.probabilities ?? {};
  if (vibe === "negative" && (vibeProbs.negative ?? 0) >= THRESHOLDS.name_negative_vibe_min_prob) {
    reasons.push({ id: "name_negative", label: REASON_LABELS.name_negative, p: vibeProbs.negative });
  }
  reasons.sort((a, b) => b.p - a.p);
  return {
    allowed: reasons.length === 0,
    reasons: reasons.slice(0, 3).map((r) => r.label),
    hits: reasons.map((r) => r.id),
    vibe,
    vibe_probs: Object.fromEntries(Object.entries(vibeProbs).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    flags,
  };
}

// ------------------------------------------------------------------ client
const cache = new Map(); // exact state string -> result
const nameCache = new Map(); // username -> result
const CACHE_MAX = 5000;
const stats = { requests: 0, total_latency_ms: 0, blocked: 0, allowed: 0, link_blocks: 0, input_tokens: 0, output_tokens: 0, errors: 0 };

function getStats() {
  return {
    ...stats,
    avg_latency_ms: stats.requests ? Math.round(stats.total_latency_ms / stats.requests) : 0,
    cache_size: cache.size,
    model: MODEL,
  };
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function budgetError() {
  const err = new Error("jev budget exhausted");
  err.cooldown = true;
  return err;
}

// Every HTTP request to Jev, retries included, goes through reserve() first.
async function callJev(body, reserve, attempt = 0) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY not set");
  if (reserve && !(await reserve())) throw budgetError();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    return callJev(body, reserve, attempt + 1);
  }
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Judge a draft. `context` = last few room messages (strings) for light context.
 * Drafts under 3 words are skipped while typing; pass `force` to judge anyway (on send).
 * `reserve` runs right before each real API request, retries included (skips and cache hits never
 * reach it), and may return false to refuse it — that's how the caller enforces a global call budget.
 */
async function judge(draft, context = [], { force = false, reserve } = {}) {
  const text = draft.trim();
  if (looksLikeLink(text)) {
    if (force) stats.link_blocks++;
    return linkVerdict();
  }
  if (!force && wordCount(text) < 3) {
    return { allowed: true, reasons: [], niceness: null, tone: null, latency_ms: 0, skipped: true };
  }
  const state = { recent_messages: context.slice(-3), draft_message: text };
  const cacheKey = JSON.stringify(state);
  if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };

  const t0 = performance.now();
  let data;
  try {
    data = await callJev({ state, model: MODEL, questions: QUESTIONS }, reserve);
  } catch (e) {
    stats.errors++;
    throw e;
  }
  const latency_ms = Math.round(performance.now() - t0);
  stats.requests++;
  stats.total_latency_ms += latency_ms;
  stats.input_tokens += data.usage?.input_tokens ?? 0;
  stats.output_tokens += data.usage?.output_tokens ?? 0;

  const result = { ...decide(data.answers), latency_ms, cached: false, skipped: false };
  if (result.allowed) stats.allowed++;
  else stats.blocked++;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, result);
  return result;
}

// One snap read of the latest human message so the room bots can pick a fitting reply template.
// Code owns the reply text; Jev only says what the message is about.
const ROOM_QUESTIONS = {
  topic: {
    type: "choice",
    instructions: "What is `last_message.text` mostly about?",
    criteria: {
      greeting: "Saying hi, joining, good morning/night, introducing themselves",
      question: "Asking the room something and waiting for an answer",
      food: "Food, drinks, coffee, cooking, snacks",
      animals: "Pets or animals",
      weather_outdoors: "Weather, nature, walks, the outdoors",
      work_school: "Work, school, studying, coding, projects",
      media: "Music, movies, shows, books, games",
      compliment: "Complimenting or thanking the room or someone in it",
      joke: "A joke, laughter or playful silliness",
      other: "Anything else",
    },
  },
  is_about_this_chat: {
    type: "noul",
    instructions: "Is `last_message.text` talking about this chat room itself (the app, Jev, the moderation, the niceness rule)?",
  },
};

async function readRoom(lastMessage, { reserve } = {}) {
  const state = { last_message: { author: lastMessage.name, text: lastMessage.text } };
  const t0 = performance.now();
  let data;
  try {
    data = await callJev({ state, model: MODEL, questions: ROOM_QUESTIONS }, reserve);
  } catch (e) {
    stats.errors++;
    throw e;
  }
  const latency_ms = Math.round(performance.now() - t0);
  stats.requests++;
  stats.total_latency_ms += latency_ms;
  stats.input_tokens += data.usage?.input_tokens ?? 0;
  stats.output_tokens += data.usage?.output_tokens ?? 0;
  const topic = data.answers.topic?.choice ?? "other";
  return {
    topic: ROOM_QUESTIONS.topic.criteria[topic] ? topic : "other",
    topic_prob: data.answers.topic?.probabilities?.[topic] ?? 0,
    about_chat: data.answers.is_about_this_chat?.noul ?? 0,
    latency_ms,
  };
}

/** Judge a display name on its own. Same budget hook as `judge`; results are cached per name. */
async function judgeName(name, { reserve } = {}) {
  const username = name.trim();
  if (nameCache.has(username)) return { ...nameCache.get(username), cached: true };
  const t0 = performance.now();
  let data;
  try {
    data = await callJev({ state: { username }, model: MODEL, questions: NAME_QUESTIONS }, reserve);
  } catch (e) {
    stats.errors++;
    throw e;
  }
  const latency_ms = Math.round(performance.now() - t0);
  stats.requests++;
  stats.total_latency_ms += latency_ms;
  stats.input_tokens += data.usage?.input_tokens ?? 0;
  stats.output_tokens += data.usage?.output_tokens ?? 0;
  const result = { ...decideName(data.answers), latency_ms, cached: false };
  if (nameCache.size >= CACHE_MAX) nameCache.delete(nameCache.keys().next().value);
  nameCache.set(username, result);
  return result;
}

module.exports = { QUESTIONS, NAME_QUESTIONS, ROOM_QUESTIONS, THRESHOLDS, MODEL, decide, decideName, judge, judgeName, readRoom, looksLikeLink, getStats };
