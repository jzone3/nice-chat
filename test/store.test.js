const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

process.env.DATA_FILE = path.join(os.tmpdir(), `nice-chat-test-${process.pid}.json`);
delete process.env.REDIS_URL;
delete process.env.KV_URL;
const store = require("../store");

const uid = "00000000-0000-4000-8000-000000000001";
const msg = (i, niceness) => ({ id: `m${i}`, name: "Ann", emoji: "🐸", text: `hello ${i}`, ts: 1000 + i, niceness, tone: "warm" });

test("memory store: users, history, since, fame, presence", async () => {
  assert.equal(await store.getUser(uid), null);
  const u = await store.upsertUser(uid, { name: "Ann", emoji: "🐸" });
  assert.equal(u.name, "Ann");
  for (let i = 0; i < 5; i++) await store.addMessage(msg(i, 2 + i * 0.5));
  assert.deepEqual((await store.history()).map((m) => m.id), ["m0", "m1", "m2", "m3", "m4"]);
  assert.deepEqual((await store.since(1003)).map((m) => m.id), ["m3", "m4"]);
  assert.deepEqual(await store.recent(2), ["Ann: hello 3", "Ann: hello 4"]);
  assert.deepEqual((await store.hallOfFame(2)).map((m) => m.id), ["m4", "m3"]);
  assert.equal(await store.messageCount(), 5);
  assert.equal((await store.presence()).online, 0);
  await store.heartbeat(uid);
  assert.deepEqual(await store.presence(), { online: 1, people: [{ name: "Ann", emoji: "🐸" }] });
  await store.leave(uid);
  assert.equal((await store.presence()).online, 0);
});

test("memory store: reactions toggle per user, counts shared, `me` per viewer", async () => {
  const other = "00000000-0000-4000-8000-000000000002";
  assert.equal(await store.hasMessage("m2"), true);
  assert.equal(await store.hasMessage("nope"), false);
  const before = Date.now();
  const first = await store.toggleReaction("m2", "❤️", uid);
  assert.ok(first.at >= before, `at ${first.at}`);
  assert.deepEqual(first, { "❤️": { n: 1, me: true }, "😂": { n: 0, me: false }, at: first.at });
  await store.toggleReaction("m2", "❤️", other);
  await store.toggleReaction("m2", "😂", other);
  const both = await store.reactions(["m2", "m3"], uid);
  assert.deepEqual(both["m2"], { "❤️": { n: 2, me: true }, "😂": { n: 1, me: false }, at: both["m2"].at });
  assert.deepEqual(both["m3"], { "❤️": { n: 0, me: false }, "😂": { n: 0, me: false }, at: 0 });
  assert.deepEqual((await store.reactions(["m2"], null))["m2"]["❤️"], { n: 2, me: false });
  // toggling again removes only my own reaction
  assert.deepEqual((await store.toggleReaction("m2", "❤️", uid))["❤️"], { n: 1, me: false });
  assert.deepEqual(Object.keys(await store.reactionsSince(before, uid)), ["m2"]);
  assert.deepEqual(await store.reactionsSince(Date.now() + 1000, uid), {});
});

test("memory store: fixed-window rate limit and stats", async () => {
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await store.allow("send", uid));
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
  assert.equal(await store.allow("send", "someone-else"), true);
  await store.bumpStats({ blocked: true, latency_ms: 100 });
  await store.bumpStats({ blocked: false, latency_ms: 50 });
  assert.deepEqual(await store.stats(), { requests: 2, blocked: 1, total_latency_ms: 150 });
});
