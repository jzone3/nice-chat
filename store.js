// store.js — the one big room: users, messages, hall of fame, presence, rate limits, Jev stats.
// Two backends behind one async API:
//   memory  — single Node process, JSON-file persistence (local dev, Docker).
//   redis   — any REDIS_URL (Vercel Marketplace Redis/Upstash); shared by every serverless instance.
const fs = require("fs");
const path = require("path");

// Serverless filesystems are read-only except /tmp; the JSON file there only outlives a warm instance.
const DATA_FILE = process.env.DATA_FILE || (process.env.VERCEL ? "/tmp/nice-chat-state.json" : path.join(__dirname, "data", "state.json"));
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 500;
const HISTORY = Number(process.env.HISTORY) || 100;
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const PREFIX = process.env.REDIS_PREFIX || "nc:";
const PRESENCE_TTL_MS = 45_000; // a poller/stream that hasn't checked in for this long is offline
const FAME_KEEP = 25;
const REACTIONS = ["❤️", "😂"];
const REACTION_TTL_S = 60 * 60 * 24 * 30;

// Fixed windows per limiter kind: every window must have room, so each kind gets a burst cap plus
// a sustained one. `*_ip` kinds are keyed by client IP so clearing cookies doesn't reset them;
// `jev` is keyed by a single constant and caps the room's total upstream Jev calls.
const MIN = 60_000;
const DAY = 24 * 60 * MIN; // fixed UTC-day buckets
// 6.25M calls ≈ $500/day at Jev's $0.042 per million input tokens (~1,900 tokens per message check).
const JEV_BUDGET_DAY = Number(process.env.JEV_BUDGET_DAY) || 6_250_000;
// Past this share of the day's budget the as-you-type preview pauses so real sends keep flowing.
const JEV_PREVIEW_SHARE = Math.min(1, Math.max(0, Number(process.env.JEV_PREVIEW_SHARE) || 0.8));
const LIMITS = {
  judge: [{ max: 8, windowMs: 5_000 }, { max: 150, windowMs: 10 * MIN }], // as-you-type checks
  judge_ip: [{ max: 300, windowMs: 10 * MIN }],
  send: [{ max: 5, windowMs: 10_000 }, { max: 40, windowMs: 10 * MIN }], // real sends
  send_ip: [{ max: 60, windowMs: 10 * MIN }],
  join: [{ max: 10, windowMs: MIN }, { max: 30, windowMs: 60 * MIN }],
  react: [{ max: 30, windowMs: 10_000 }, { max: 300, windowMs: 10 * MIN }],
  jev: [{ max: JEV_BUDGET_DAY, windowMs: DAY }],
};

const jevBudget = (used) => ({
  used: Math.min(used, JEV_BUDGET_DAY),
  max: JEV_BUDGET_DAY,
  preview_paused: used >= JEV_BUDGET_DAY * JEV_PREVIEW_SHARE,
});

const pub = (u) => (u ? { name: u.name, emoji: u.emoji } : null);
const fameSort = (a, b) => b.niceness - a.niceness || b.ts - a.ts;
// { "❤️": { n: 3, me: true }, "😂": { n: 0, me: false }, at: <ms of last change> } — `at` lets clients drop stale snapshots.
const shapeReactions = (counts, mine, at) => ({
  ...Object.fromEntries(REACTIONS.map((e) => [e, { n: Math.max(0, Number(counts[e]) || 0), me: Boolean(mine[e]) }])),
  at: Number(at) || 0,
});

// Membership set + count hash + changed-at zset must move together, or overlapping toggles from one
// user (several tabs) can double-decrement.
const TOGGLE_LUA = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 1 then
  redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
else
  redis.call('SREM', KEYS[1], ARGV[1])
  if tonumber(redis.call('HINCRBY', KEYS[2], ARGV[2], -1)) < 0 then redis.call('HSET', KEYS[2], ARGV[2], 0) end
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -tonumber(ARGV[6]) - 1)
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return added`;

// ------------------------------------------------------------------ memory
function memoryStore() {
  const state = { users: {}, messages: [], reactions: {} }; // reactions: id -> emoji -> [uid]
  const seen = new Map(); // uid -> last heartbeat
  const reactedAt = new Map(); // message id -> last reaction change ms
  const hits = new Map(); // limiter key -> { n, reset }
  let saveTimer = null;
  const stats = { requests: 0, blocked: 0, total_latency_ms: 0 };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (raw && typeof raw.users === "object") state.users = raw.users;
      if (Array.isArray(raw?.messages)) state.messages = raw.messages.slice(-MAX_MESSAGES);
      if (raw?.reactions && typeof raw.reactions === "object") state.reactions = raw.reactions;
      console.log(`[store] loaded ${state.messages.length} messages, ${Object.keys(state.users).length} users from ${DATA_FILE}`);
    } catch (e) {
      if (e.code !== "ENOENT") console.error("[store] load failed:", e.message);
    }
  }
  function save() {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error("[store] save failed:", e.message);
    }
  }
  const scheduleSave = () => (saveTimer ||= setTimeout(save, 1000));

  function presence(now = Date.now()) {
    const people = [];
    for (const [uid, t] of seen) {
      if (now - t > PRESENCE_TTL_MS) seen.delete(uid);
      else if (state.users[uid]) people.push(pub(state.users[uid]));
    }
    return { online: people.length, people: people.slice(0, 60) };
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
  }, 60_000).unref();

  function reactionsFor(ids, uid) {
    const out = {};
    for (const id of ids) {
      const byEmoji = state.reactions[id] || {};
      const counts = {};
      const mine = {};
      for (const e of REACTIONS) {
        counts[e] = (byEmoji[e] || []).length;
        mine[e] = Boolean(uid) && (byEmoji[e] || []).includes(uid);
      }
      out[id] = shapeReactions(counts, mine, reactedAt.get(id));
    }
    return out;
  }

  return {
    kind: "memory",
    shared: false,
    load,
    save,
    async getUser(uid) {
      return uid ? state.users[uid] || null : null;
    },
    async upsertUser(uid, { name, emoji }) {
      const prev = state.users[uid] || { uid, created: Date.now() };
      state.users[uid] = { ...prev, name, emoji, seen: Date.now() };
      scheduleSave();
      return state.users[uid];
    },
    async addMessage(msg) {
      state.messages.push(msg);
      if (state.messages.length > MAX_MESSAGES) {
        for (const old of state.messages.splice(0, state.messages.length - MAX_MESSAGES)) {
          delete state.reactions[old.id];
          reactedAt.delete(old.id);
        }
      }
      scheduleSave();
      return msg;
    },
    async hasMessage(id) {
      return state.messages.some((m) => m.id === id);
    },
    async toggleReaction(id, emoji, uid) {
      const byEmoji = (state.reactions[id] ||= {});
      const uids = (byEmoji[emoji] ||= []);
      const i = uids.indexOf(uid);
      if (i >= 0) uids.splice(i, 1);
      else uids.push(uid);
      reactedAt.set(id, Date.now());
      scheduleSave();
      return reactionsFor([id], uid)[id];
    },
    async reactions(ids, uid) {
      return reactionsFor(ids, uid);
    },
    async reactionsSince(ts, uid) {
      const ids = [...reactedAt].filter(([, t]) => t >= ts).map(([id]) => id);
      return reactionsFor(ids, uid);
    },
    async history() {
      return state.messages.slice(-HISTORY);
    },
    async since(ts) {
      return state.messages.filter((m) => m.ts >= ts).slice(-HISTORY);
    },
    async recent(n) {
      return state.messages.slice(-n).map((m) => `${m.name}: ${m.text}`);
    },
    async hallOfFame(n = 5) {
      return state.messages.filter((m) => m.niceness != null).sort(fameSort).slice(0, n);
    },
    async messageCount() {
      return state.messages.length;
    },
    async heartbeat(uid) {
      if (uid) seen.set(uid, Date.now());
    },
    async leave(uid) {
      if (uid) seen.delete(uid);
    },
    async presence() {
      return presence();
    },
    async allow(kind, key) {
      const now = Date.now();
      let ok = true;
      for (const { max, windowMs } of LIMITS[kind]) {
        const k = `${kind}:${key}:${windowMs}`;
        let h = hits.get(k);
        if (!h || h.reset <= now) hits.set(k, (h = { n: 0, reset: (Math.floor(now / windowMs) + 1) * windowMs }));
        if (++h.n > max) ok = false;
      }
      return ok;
    },
    async jevBudget() {
      const now = Date.now();
      const h = hits.get(`jev:room:${DAY}`);
      return jevBudget(h && h.reset > now ? h.n : 0);
    },
    async bumpStats({ blocked, latency_ms }) {
      stats.requests++;
      stats.total_latency_ms += latency_ms || 0;
      if (blocked) stats.blocked++;
    },
    async stats() {
      return { ...stats };
    },
  };
}

// ------------------------------------------------------------------- redis
function redisStore(url) {
  const { Redis } = require("./redis");
  const r = new Redis(url);
  const K = {
    user: (uid) => `${PREFIX}user:${uid}`,
    messages: `${PREFIX}messages`, // list of JSON, oldest first
    fame: `${PREFIX}fame`, // zset score=niceness member=JSON
    presence: `${PREFIX}presence`, // zset score=last heartbeat ms member=uid
    stats: `${PREFIX}stats`, // hash
    rx: (id) => `${PREFIX}rx:${id}`, // hash emoji -> count
    rxu: (id) => `${PREFIX}rxu:${id}`, // set of "emoji:uid"
    rxts: `${PREFIX}rxts`, // zset score=last change ms member=message id
    rl: (kind, key, win) => `${PREFIX}rl:${kind}:${key}:${win}`,
  };
  const parseAll = (arr) => (arr || []).map((s) => JSON.parse(s));
  // pipeline() hands back per-command errors inline; writes must not look successful when one failed.
  async function write(cmds) {
    const replies = await r.pipeline(cmds);
    const err = replies.find((x) => x instanceof Error);
    if (err) throw err;
    return replies;
  }

  async function usersByUid(uids) {
    if (!uids.length) return [];
    const rows = await r.exec(["MGET", ...uids.map(K.user)]);
    return rows.map((s) => (s ? JSON.parse(s) : null));
  }

  async function presence(now = Date.now()) {
    const [, online, uids] = await write([
      ["ZREMRANGEBYSCORE", K.presence, "-inf", String(now - PRESENCE_TTL_MS)],
      ["ZCARD", K.presence],
      ["ZREVRANGE", K.presence, "0", "59"],
    ]);
    const people = (await usersByUid(uids || [])).filter(Boolean).map(pub);
    return { online: Number(online), people };
  }

  async function reactionsFor(ids, uid) {
    if (!ids.length) return {};
    const cmds = [];
    for (const id of ids) {
      cmds.push(["HGETALL", K.rx(id)], ["ZSCORE", K.rxts, id]);
      if (uid) cmds.push(["SMISMEMBER", K.rxu(id), ...REACTIONS.map((e) => `${e}:${uid}`)]);
    }
    const replies = await write(cmds);
    const out = {};
    let i = 0;
    for (const id of ids) {
      const h = replies[i++] || [];
      const counts = {};
      for (let j = 0; j < h.length; j += 2) counts[h[j]] = h[j + 1];
      const at = replies[i++];
      const mine = {};
      if (uid) {
        const flags = replies[i++] || [];
        REACTIONS.forEach((e, k) => (mine[e] = Number(flags[k]) === 1));
      }
      out[id] = shapeReactions(counts, mine, at);
    }
    return out;
  }

  return {
    kind: "redis",
    shared: true,
    load() {
      console.log(`[store] redis ${new URL(url).host} prefix=${PREFIX}`);
    },
    save() {},
    async getUser(uid) {
      if (!uid) return null;
      const s = await r.exec(["GET", K.user(uid)]);
      return s ? JSON.parse(s) : null;
    },
    async upsertUser(uid, { name, emoji }) {
      const prev = (await this.getUser(uid)) || { uid, created: Date.now() };
      const u = { ...prev, name, emoji, seen: Date.now() };
      await r.exec(["SET", K.user(uid), JSON.stringify(u), "EX", String(60 * 60 * 24 * 400)]);
      return u;
    },
    async addMessage(msg) {
      const s = JSON.stringify(msg);
      const cmds = [
        ["RPUSH", K.messages, s],
        ["LTRIM", K.messages, String(-MAX_MESSAGES), "-1"],
      ];
      if (msg.niceness != null) {
        cmds.push(["ZADD", K.fame, String(msg.niceness + msg.ts / 1e16), s]);
        cmds.push(["ZREMRANGEBYRANK", K.fame, "0", String(-FAME_KEEP - 1)]);
      }
      await write(cmds);
      return msg;
    },
    async hasMessage(id) {
      return (await this.history()).some((m) => m.id === id);
    },
    async toggleReaction(id, emoji, uid) {
      await r.exec(["EVAL", TOGGLE_LUA, "3", K.rxu(id), K.rx(id), K.rxts, `${emoji}:${uid}`, emoji, String(Date.now()), id, String(REACTION_TTL_S), String(MAX_MESSAGES)]);
      return (await reactionsFor([id], uid))[id];
    },
    async reactions(ids, uid) {
      return reactionsFor(ids, uid);
    },
    async reactionsSince(ts, uid) {
      const ids = (await r.exec(["ZRANGEBYSCORE", K.rxts, String(ts), "+inf"])) || [];
      return reactionsFor(ids, uid);
    },
    async history() {
      return parseAll(await r.exec(["LRANGE", K.messages, String(-HISTORY), "-1"]));
    },
    async since(ts) {
      // Messages arrive roughly in ts order; scanning the last HISTORY is enough for a poller.
      return (await this.history()).filter((m) => m.ts >= ts);
    },
    async recent(n) {
      return parseAll(await r.exec(["LRANGE", K.messages, String(-n), "-1"])).map((m) => `${m.name}: ${m.text}`);
    },
    async hallOfFame(n = 5) {
      return parseAll(await r.exec(["ZREVRANGE", K.fame, "0", String(n - 1)])).sort(fameSort);
    },
    async messageCount() {
      return Number(await r.exec(["LLEN", K.messages]));
    },
    async heartbeat(uid) {
      if (uid) await r.exec(["ZADD", K.presence, String(Date.now()), uid]);
    },
    async leave(uid) {
      if (uid) await r.exec(["ZREM", K.presence, uid]);
    },
    async presence() {
      return presence();
    },
    async allow(kind, key) {
      const now = Date.now();
      const windows = LIMITS[kind];
      const replies = await write(
        windows.flatMap(({ windowMs }) => {
          const k = K.rl(kind, key, `${windowMs}:${Math.floor(now / windowMs)}`);
          return [["INCR", k], ["PEXPIRE", k, String(windowMs * 2)]];
        })
      );
      return windows.every(({ max }, i) => Number(replies[i * 2]) <= max);
    },
    async jevBudget() {
      const used = await r.exec(["GET", K.rl("jev", "room", `${DAY}:${Math.floor(Date.now() / DAY)}`)]);
      return jevBudget(Number(used) || 0);
    },
    async bumpStats({ blocked, latency_ms }) {
      const cmds = [
        ["HINCRBY", K.stats, "requests", "1"],
        ["HINCRBY", K.stats, "total_latency_ms", String(Math.round(latency_ms || 0))],
      ];
      if (blocked) cmds.push(["HINCRBY", K.stats, "blocked", "1"]);
      await write(cmds);
    },
    async stats() {
      const h = (await r.exec(["HGETALL", K.stats])) || [];
      const out = { requests: 0, blocked: 0, total_latency_ms: 0 };
      for (let i = 0; i < h.length; i += 2) out[h[i]] = Number(h[i + 1]);
      return out;
    },
  };
}

module.exports = REDIS_URL ? redisStore(REDIS_URL) : memoryStore();
module.exports.HISTORY = HISTORY;
module.exports.REACTIONS = REACTIONS;
