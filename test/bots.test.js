const test = require("node:test");
const assert = require("node:assert/strict");
const bots = require("../bots");

function fakeStore(messages, claimOk = true) {
  const added = [];
  return {
    added,
    async claim() {
      return claimOk;
    },
    async history() {
      return messages;
    },
    async addMessage(m) {
      added.push(m);
      return m;
    },
  };
}
const ok = { allowed: true, niceness: 4.5, tone: "warm", kind: 0.9, flags: {}, tone_probs: {}, niceness_probs: {}, latency_ms: 1 };
const human = (text, ts) => ({ id: "h" + ts, name: "Ann", emoji: "🐸", text, ts, niceness: 4 });

test("bots: no claim, no post (only one instance speaks per window)", async () => {
  const store = fakeStore([], false);
  assert.equal(await bots.tick({ store, readRoom: () => assert.fail("no jev"), judge: () => assert.fail("no jev") }), null);
});

test("bots: answers a fresh human message using the Jev topic, addressing them by name", async () => {
  const now = 10_000_000;
  const store = fakeStore([human("anyone tried the new ramen place?", now - 30_000)]);
  const rnd = Math.random;
  Math.random = () => 0.1; // take the reply branch
  try {
    const msg = await bots.tick({
      store,
      now,
      readRoom: async (m) => {
        assert.equal(m.text, "anyone tried the new ramen place?");
        return { topic: "food", topic_prob: 0.8, about_chat: 0.02 };
      },
      judge: async (text, ctx, opts) => {
        assert.equal(opts.force, true);
        assert.ok(ctx.length <= 3);
        return ok;
      },
    });
    assert.ok(msg.bot);
    assert.ok(bots.BOTS.some((b) => b.name === msg.name && b.emoji === msg.emoji));
    assert.ok(bots.REPLIES.food.map((t) => t.replaceAll("{name}", "Ann")).includes(msg.text), msg.text);
    assert.ok(msg.ts >= Date.now() - 5_000, "stamped at insert time, not when the tick started");
    assert.equal(msg.id.slice(0, msg.ts.toString(36).length), msg.ts.toString(36));
    assert.equal(msg.niceness, 4.5);
    assert.deepEqual(store.added, [msg]);
  } finally {
    Math.random = rnd;
  }
});

test("bots: talks about their day when the last human line is stale or already answered", async () => {
  const now = 10_000_000;
  for (const history of [
    [human("hi all", now - 10 * 60_000)],
    [human("hi all", now - 30_000), { name: "maya", emoji: "🌼", text: "hi Ann!", ts: now - 20_000, bot: true }],
    [],
  ]) {
    const store = fakeStore(history);
    const msg = await bots.tick({ store, now, readRoom: () => assert.fail("no jev read needed"), judge: async () => ok });
    assert.ok(bots.LIFE.includes(msg.text), msg.text);
    if (history.some((m) => m.bot)) assert.notEqual(msg.name, "maya", "never the same regular twice in a row");
  }
});

test("bots: a line Jev refuses is dropped", async () => {
  const store = fakeStore([]);
  const msg = await bots.tick({ store, readRoom: async () => ({ topic: "other" }), judge: async () => ({ allowed: false, reasons: [{ id: "is_negative" }] }) });
  assert.equal(msg, null);
  assert.deepEqual(store.added, []);
});

test("bots: every template fits the room's max length and never mentions a link", () => {
  const { looksLikeLink } = require("../jev");
  const all = [...bots.LIFE, ...Object.values(bots.REPLIES).flat().map((t) => t.replaceAll("{name}", "somebody_longname_20"))];
  for (const t of all) {
    assert.ok(t.length <= 280, t);
    assert.equal(looksLikeLink(t), false, t);
  }
});
