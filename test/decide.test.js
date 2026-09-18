const test = require("node:test");
const assert = require("node:assert");
const { decide } = require("../jev");

function answers(over = {}) {
  const base = {
    is_kind: { noul: 0.9 },
    is_insult: { noul: 0.02 },
    is_sarcastic_or_backhanded: { noul: 0.03 },
    is_passive_aggressive: { noul: 0.02 },
    is_profane_or_slur: { noul: 0.01 },
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
