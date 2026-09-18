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

// Fixed windows per limiter kind: at most `max` hits per `windowMs` for one key (uid or ip).
const LIMITS = {
  judge: { max: 8, windowMs: 5_000 }, // as-you-type checks
  send: { max: 5, windowMs: 10_000 }, // real sends
  join: { max: 10, windowMs: 60_000 },
};

const pub = (u) => (u ? { name: u.name, emoji: u.emoji } : null);
const fameSort = (a, b) => b.niceness - a.niceness || b.ts - a.ts;

// ------------------------------------------------------------------ memory
function memoryStore() {
  const state = { users: {}, messages: [] };
  const seen = new Map(); // uid -> last heartbeat
  const hits = new Map(); // limiter key -> { n, reset }
  let saveTimer = null;
  const stats = { requests: 0, blocked: 0, total_latency_ms: 0 };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (raw && typeof raw.users === "object") state.users = raw.users;
      if (Array.isArray(raw?.messages)) state.messages = raw.messages.slice(-MAX_MESSAGES);
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
    for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  }, 60_000).unref();

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
      if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
      scheduleSave();
      return msg;
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
      const { max, windowMs } = LIMITS[kind];
      const now = Date.now();
      const k = `${kind}:${key}`;
      let h = hits.get(k);
      if (!h || h.reset < now) hits.set(k, (h = { n: 0, reset: now + windowMs }));
      return ++h.n <= max;
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
    rl: (kind, key, win) => `${PREFIX}rl:${kind}:${key}:${win}`,
  };
  const parseAll = (arr) => (arr || []).map((s) => JSON.parse(s));

  async function usersByUid(uids) {
    if (!uids.length) return [];
    const rows = await r.exec(["MGET", ...uids.map(K.user)]);
    return rows.map((s) => (s ? JSON.parse(s) : null));
  }

  async function presence(now = Date.now()) {
    const [, uids] = await r.pipeline([
      ["ZREMRANGEBYSCORE", K.presence, "-inf", String(now - PRESENCE_TTL_MS)],
      ["ZRANGE", K.presence, "0", "199"],
    ]);
    const people = (await usersByUid(uids || [])).filter(Boolean).map(pub);
    return { online: people.length, people: people.slice(0, 60) };
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
      await r.pipeline(cmds);
      return msg;
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
      const { max, windowMs } = LIMITS[kind];
      const k = K.rl(kind, key, Math.floor(Date.now() / windowMs));
      const [n] = await r.pipeline([
        ["INCR", k],
        ["PEXPIRE", k, String(windowMs * 2)],
      ]);
      if (n instanceof Error) throw n;
      return Number(n) <= max;
    },
    async bumpStats({ blocked, latency_ms }) {
      const cmds = [
        ["HINCRBY", K.stats, "requests", "1"],
        ["HINCRBY", K.stats, "total_latency_ms", String(Math.round(latency_ms || 0))],
      ];
      if (blocked) cmds.push(["HINCRBY", K.stats, "blocked", "1"]);
      await r.pipeline(cmds);
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
