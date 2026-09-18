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
  is_sarcastic_or_backhanded: 0.6,
  is_passive_aggressive: 0.65,
  hostile_tone_min_prob: 0.55, // tone == hostile with at least this probability
  cold_tone_min_prob: 0.75, // very confidently cold also blocks
  niceness_min: 2.5, // score below this blocks even if no flag fired
  kind_rescue: 0.85, // very kind + only soft flags -> let it through
};

const REASON_LABELS = {
  is_harassment_or_threat: "that reads as a threat",
  is_profane_or_slur: "watch the language",
  is_disguised_slur: "nice try hiding that",
  is_hateful: "no hate here",
  is_derogatory_label: "that word is used to put people down",
  is_insult: "that's an insult",
  is_sarcastic_or_backhanded: "sounds sarcastic",
  is_passive_aggressive: "a bit passive-aggressive",
  hostile: "hostile tone",
  cold: "pretty cold",
  low_niceness: "not quite nice enough",
};

const HARD_FLAGS = ["is_harassment_or_threat", "is_profane_or_slur", "is_disguised_slur", "is_hateful", "is_derogatory_label", "is_insult"];

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

  const hardHit = reasons.some((r) => HARD_FLAGS.includes(r.id) || r.id === "hostile");
  if (!hardHit && kind >= THRESHOLDS.kind_rescue) {
    // Very kind message with only soft flags: trust the kindness.
    reasons.length = 0;
  }
  if (reasons.length === 0 && niceness < THRESHOLDS.niceness_min) {
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
    0.7 * (flags.is_passive_aggressive ?? 0)
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

// ------------------------------------------------------------------ client
const cache = new Map(); // exact state string -> result
const CACHE_MAX = 5000;
const stats = { requests: 0, total_latency_ms: 0, blocked: 0, allowed: 0, input_tokens: 0, output_tokens: 0, errors: 0 };

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

module.exports = { QUESTIONS, THRESHOLDS, MODEL, decide, judge, getStats };
