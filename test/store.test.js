const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

process.env.DATA_FILE = path.join(os.tmpdir(), `nice-chat-test-${process.pid}.json`);
delete process.env.REDIS_URL;
delete process.env.KV_URL;
process.env.JEV_BUDGET_DAY = "3";
const store = require("../store");

const uid = "00000000-0000-4000-8000-000000000001";
const msg = (i, niceness) => ({ id: `m${i}`, name: "Ann", emoji: "🐸", text: `hello ${i}`, ts: 1000 + i, niceness, tone: "warm" });
const HOUR = 3_600_000;

test("memory store: users, history, since, fame, presence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 }); // same clock hour as the fixture timestamps
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

test("memory store: leaderboard is per clock hour and skips bot lines", async (t) => {
  const top = 10 * HOUR + 5 * 60_000; // 10:05
  t.mock.timers.enable({ apis: ["Date"], now: top });
  assert.equal(store.fameResetsAt(), 11 * HOUR);
  await store.addMessage({ ...msg(10, 4.9), ts: top - 10 * 60_000 }); // 09:55 → last hour
  await store.addMessage({ ...msg(11, 4.2), ts: top - 60_000 });
  await store.addMessage({ ...msg(12, 5.0), ts: top - 30_000, bot: true, name: "maya" });
  await store.addMessage({ ...msg(13, 4.6), ts: top });
  assert.deepEqual((await store.hallOfFame()).map((m) => m.id), ["m13", "m11"]);
  t.mock.timers.tick(55 * 60_000); // 11:00
  assert.deepEqual(await store.hallOfFame(), []);
  assert.equal(store.fameResetsAt(), 12 * HOUR);
});

test("memory store: claim is a TTL mutex", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  assert.equal(await store.claim("bots", 60_000), true);
  assert.equal(await store.claim("bots", 60_000), false);
  t.mock.timers.tick(59_000);
  assert.equal(await store.claim("bots", 60_000), false);
  t.mock.timers.tick(1_000);
  assert.equal(await store.claim("bots", 60_000), true);
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

test("memory store: sustained window keeps biting after the burst window resets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const who = "typist";
  let allowed = 0;
  // judge = 8 per 5s burst, 150 per 10min sustained: stay just under the burst cap in each fresh 5s window
  for (let round = 0; round < 25; round++) {
    for (let i = 0; i < 8; i++) if (await store.allow("judge", who)) allowed++;
    t.mock.timers.tick(5_000);
  }
  assert.equal(allowed, 150);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(await store.allow("judge", who), true);
});

test("memory store: room-wide jev budget resets at UTC midnight, not 24h after first call", async (t) => {
  const DAY = 86_400_000;
  const midnight = Math.ceil(Date.now() / DAY) * DAY; // next UTC midnight
  t.mock.timers.enable({ apis: ["Date"], now: midnight - 60 * 60_000 }); // 23:00 UTC
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await store.allow("jev", "room"));
  assert.deepEqual(results, [true, true, true, false, false]);
  t.mock.timers.tick(59 * 60_000); // 23:59
  assert.equal(await store.allow("jev", "room"), false);
  t.mock.timers.tick(60_000); // 00:00 next day
  assert.equal(await store.allow("jev", "room"), true);
});

test("memory store: jevBudget reports today's spend and pauses the preview at 80%", async (t) => {
  const DAY = 86_400_000;
  const midnight = Math.ceil(Date.now() / DAY) * DAY;
  t.mock.timers.enable({ apis: ["Date"], now: midnight + 2 * DAY }); // a fresh, untouched day
  assert.deepEqual(await store.jevBudget(), { used: 0, max: 3, preview_paused: false });
  await store.allow("jev", "room");
  assert.deepEqual(await store.jevBudget(), { used: 1, max: 3, preview_paused: false });
  await store.allow("jev", "room");
  await store.allow("jev", "room");
  assert.deepEqual(await store.jevBudget(), { used: 3, max: 3, preview_paused: true });
  await store.allow("jev", "room"); // refused, but never reported above the cap
  assert.equal((await store.jevBudget()).used, 3);
  t.mock.timers.tick(DAY);
  assert.deepEqual(await store.jevBudget(), { used: 0, max: 3, preview_paused: false });
});
