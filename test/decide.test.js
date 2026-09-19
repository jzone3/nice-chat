const test = require("node:test");
const assert = require("node:assert");
const { decide, decideName, judge } = require("../jev");

function answers(over = {}) {
  const base = {
    is_kind: { noul: 0.9 },
    is_insult: { noul: 0.02 },
    is_sarcastic_or_backhanded: { noul: 0.03 },
    is_passive_aggressive: { noul: 0.02 },
    is_profane_or_slur: { noul: 0.01 },
    is_derogatory_label: { noul: 0.02 },
    is_hateful: { noul: 0.01 },
    is_harassment_or_threat: { noul: 0.01 },
    tone: { choice: "warm", probabilities: { warm: 0.9, neutral: 0.08, cold: 0.01, hostile: 0.01 } },
    niceness: { score: 3.6, probabilities: { 0: 0, 1: 0.01, 2: 0.05, 3: 0.3, 4: 0.64 } },
  };
  return { ...base, ...over };
}

test("kind message is allowed with low meanness", () => {
  const d = decide(answers());
  assert.equal(d.allowed, true);
  assert.deepEqual(d.hits, []);
  assert.ok(d.meanness < 0.2, `meanness ${d.meanness}`);
  assert.equal(d.niceness, 4.6);
  assert.deepEqual(Object.keys(d.niceness_probs), ["1", "2", "3", "4", "5"]);
});

test("insult is blocked with high meanness", () => {
  const d = decide(
    answers({
      is_kind: { noul: 0.02 },
      is_insult: { noul: 0.95 },
      tone: { choice: "hostile", probabilities: { warm: 0.01, neutral: 0.02, cold: 0.1, hostile: 0.87 } },
      niceness: { score: 0.2, probabilities: { 0: 0.8, 1: 0.2, 2: 0, 3: 0, 4: 0 } },
    })
  );
  assert.equal(d.allowed, false);
  assert.ok(d.hits.includes("is_insult"));
  assert.ok(d.hits.includes("hostile"));
  assert.ok(d.meanness >= 0.9, `meanness ${d.meanness}`);
});

test("mild sarcasm is blocked but with moderate meanness", () => {
  const d = decide(
    answers({
      is_kind: { noul: 0.3 },
      is_sarcastic_or_backhanded: { noul: 0.7 },
      tone: { choice: "cold", probabilities: { warm: 0.1, neutral: 0.3, cold: 0.5, hostile: 0.1 } },
      niceness: { score: 1.4, probabilities: { 0: 0.1, 1: 0.5, 2: 0.3, 3: 0.1, 4: 0 } },
    })
  );
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["is_sarcastic_or_backhanded"]);
  assert.ok(d.meanness > 0.4 && d.meanness < 0.8, `meanness ${d.meanness}`);
});

test("very kind message survives a soft flag", () => {
  const d = decide(answers({ is_passive_aggressive: { noul: 0.7 }, is_kind: { noul: 0.92 } }));
  assert.equal(d.allowed, true);
});

test("bare derogatory label blocks even when otherwise neutral and not rescued by kindness", () => {
  const d = decide(
    answers({
      is_kind: { noul: 0.9 },
      is_derogatory_label: { noul: 0.88 },
      tone: { choice: "neutral", probabilities: { warm: 0.2, neutral: 0.7, cold: 0.08, hostile: 0.02 } },
      niceness: { score: 1.7, probabilities: { 0: 0.05, 1: 0.3, 2: 0.55, 3: 0.1, 4: 0 } },
    })
  );
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["is_derogatory_label"]);
  assert.ok(d.meanness >= 0.85, `meanness ${d.meanness}`);
});

test("hateful generalisation is a hard block", () => {
  const d = decide(answers({ is_hateful: { noul: 0.6 }, is_kind: { noul: 0.9 } }));
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["is_hateful"]);
});

test("plain but too-cold message is blocked on niceness floor", () => {
  const d = decide(
    answers({
      is_kind: { noul: 0.1 },
      tone: { choice: "neutral", probabilities: { warm: 0.05, neutral: 0.6, cold: 0.3, hostile: 0.05 } },
      niceness: { score: 1.0, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2, 3: 0, 4: 0 } },
    })
  );
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["low_niceness"]);
});

test("judge: reserve() is consulted only when a real Jev call is about to happen", async (t) => {
  process.env.TYPESAFE_API_KEY ||= "test-key";
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in unit tests"); });
  let asked = 0;
  const reserve = async () => (asked++, false);
  const short = await judge("hi there", [], { reserve });
  assert.strictEqual(short.skipped, true);
  assert.strictEqual(asked, 0);
  await assert.rejects(judge("thank you so much friend", [], { reserve }), (e) => e.cooldown === true);
  assert.strictEqual(asked, 1);
  assert.strictEqual(fetchMock.mock.callCount(), 0);
});

test("judge: every upstream request, retries included, is charged to the budget", async (t) => {
  process.env.TYPESAFE_API_KEY ||= "test-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls < 3) return new Response("busy", { status: 503 });
    return Response.json({ answers: answers(), usage: { input_tokens: 1, output_tokens: 1 } });
  });
  let asked = 0;
  const v = await judge("retry accounting draft please", [], { reserve: async () => (asked++, true) });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(calls, 3);
  assert.strictEqual(asked, 3);

  // budget runs out mid-retry: the retry is refused, not sent
  calls = 0;
  let left = 1;
  await assert.rejects(
    judge("another retry accounting draft", [], { reserve: async () => left-- > 0 }),
    (e) => e.cooldown === true
  );
  assert.strictEqual(calls, 1);
});

test("plain laughter is allowed even when Jev reads it as cold/mocking in context", () => {
  const d = decide(
    answers({
      is_kind: { noul: 0.1 },
      is_laughter: { noul: 0.97 },
      is_insult: { noul: 0.55 },
      is_sarcastic_or_backhanded: { noul: 0.5 },
      tone: { choice: "cold", probabilities: { warm: 0.05, neutral: 0.1, cold: 0.8, hostile: 0.05 } },
      niceness: { score: 0.6, probabilities: { 0: 0.5, 1: 0.4, 2: 0.1, 3: 0, 4: 0 } },
    })
  );
  assert.equal(d.allowed, true);
  assert.deepEqual(d.hits, []);
});

test("laughter does not excuse profanity, slurs or hate", () => {
  const d = decide(answers({ is_laughter: { noul: 0.9 }, is_profane_or_slur: { noul: 0.8 } }));
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["is_profane_or_slur"]);
});

// ---------------------------------------------------------------- names
function nameAnswers(over = {}) {
  const base = {
    name_is_profane_or_slur: { noul: 0.01 },
    name_is_derogatory: { noul: 0.02 },
    name_is_hateful: { noul: 0.01 },
    name_is_sexual: { noul: 0.01 },
    name_is_hostile: { noul: 0.02 },
    name_vibe: { choice: "neutral", probabilities: { positive: 0.3, neutral: 0.65, negative: 0.05 } },
  };
  return { ...base, ...over };
}

test("plain or cheerful names are allowed", () => {
  assert.equal(decideName(nameAnswers()).allowed, true);
  assert.equal(decideName(nameAnswers({ name_vibe: { choice: "positive", probabilities: { positive: 0.9, neutral: 0.1, negative: 0 } } })).allowed, true);
});

test("a disguised slur in a name is blocked", () => {
  const d = decideName(nameAnswers({ name_is_profane_or_slur: { noul: 0.7 } }));
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["name_is_profane_or_slur"]);
  assert.deepEqual(d.reasons, ["no swears or slurs in a name"]);
});

test("a confidently negative vibe blocks a name even with no flag fired", () => {
  const d = decideName(nameAnswers({ name_vibe: { choice: "negative", probabilities: { positive: 0.05, neutral: 0.25, negative: 0.7 } } }));
  assert.equal(d.allowed, false);
  assert.deepEqual(d.hits, ["name_negative"]);
});

test("an edgy-but-harmless name with a weak negative lean is allowed", () => {
  const d = decideName(nameAnswers({ name_is_hostile: { noul: 0.3 }, name_vibe: { choice: "negative", probabilities: { positive: 0.1, neutral: 0.45, negative: 0.45 } } }));
  assert.equal(d.allowed, true);
});
