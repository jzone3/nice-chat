// Nice Chat server: one big room, zero dependencies. Static files + SSE fan-out + Jev gate.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { judge, getStats, MODEL } = require("./jev");
const store = require("./store");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const COOKIE = "nc_uid";
const MAX_TEXT = 400;
const MAX_JEV_INFLIGHT = Number(process.env.MAX_JEV_INFLIGHT) || 48;

// ------------------------------------------------------------------ helpers
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function setUidCookie(req, uid) {
  const parts = [`${COOKIE}=${uid}`, "Path=/", `Max-Age=${60 * 60 * 24 * 365}`, "HttpOnly", "SameSite=Lax"];
  if (isSecure(req)) parts.push("Secure");
  return { "Set-Cookie": parts.join("; ") };
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;
function cleanProfile(body) {
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
  const emoji = String(body.emoji ?? "").trim();
  if (name.length < 1) return { error: "Pick a name" };
  if (!EMOJI_RE.test(emoji) || [...emoji].length > 4 || emoji.length > 16) return { error: "Pick an emoji" };
  return { name, emoji };
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

// Token buckets keyed by user/ip: protects the Jev budget from one noisy tab.
class Bucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.map = new Map();
  }
  take(key) {
    const now = Date.now();
    let b = this.map.get(key);
    if (!b) {
      b = { tokens: this.capacity, t: now };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.t) / 1000) * this.refill);
    b.t = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  sweep() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, b] of this.map) if (b.t < cutoff) this.map.delete(k);
  }
}
const judgeBucket = new Bucket(6, 1.5); // as-you-type checks
const sendBucket = new Bucket(5, 0.5); // real sends
const joinBucket = new Bucket(10, 0.2);
setInterval(() => [judgeBucket, sendBucket, joinBucket].forEach((b) => b.sweep()), 60_000).unref();

let jevInflight = 0;
async function gatedJudge(...args) {
  if (jevInflight >= MAX_JEV_INFLIGHT) {
    const err = new Error("busy");
    err.busy = true;
    throw err;
  }
  jevInflight++;
  try {
    return await judge(...args);
  } finally {
    jevInflight--;
  }
}

// ---------------------------------------------------------------- realtime
const clients = new Set(); // { res, uid }
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(payload);
}

function presence() {
  const byUid = new Map();
  for (const c of clients) {
    const u = store.getUser(c.uid);
    if (u && !byUid.has(c.uid)) byUid.set(c.uid, { name: u.name, emoji: u.emoji });
  }
  const people = [...byUid.values()];
  return { online: people.length, connections: clients.size, people: people.slice(0, 60) };
}

let presenceTimer = null;
function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    broadcast("presence", presence());
  }, 300);
}

setInterval(() => {
  for (const c of clients) c.res.write(": ping\n\n");
}, 25_000).unref();

function publicUser(u) {
  return u ? { name: u.name, emoji: u.emoji } : null;
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const cookies = parseCookies(req);
  const uid = cookies[COOKIE] && /^[a-f0-9-]{36}$/.test(cookies[COOKIE]) ? cookies[COOKIE] : null;
  const user = store.getUser(uid);

  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, online: presence().online, messages: store.messageCount() });

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const p = path.normalize(path.join(PUBLIC, file));
      const ext = path.extname(p);
      if (!p.startsWith(PUBLIC) || !MIME[ext] || !fs.existsSync(p)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-cache" });
      return fs.createReadStream(p).pipe(res);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      if (!user) return send(res, 401, { user: null });
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      if (!joinBucket.take(clientIp(req))) return send(res, 429, { error: "Slow down a little" });
      const prof = cleanProfile(await readJson(req));
      if (prof.error) return send(res, 400, { error: prof.error });
      const id = uid || crypto.randomUUID();
      const u = store.upsertUser(id, prof);
      schedulePresence();
      return send(res, 200, { user: publicUser(u) }, setUidCookie(req, id));
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const client = { res, uid };
      clients.add(client);
      res.write(`retry: 3000\n`);
      res.write(`event: history\ndata: ${JSON.stringify({ messages: store.history(), fame: store.hallOfFame(), presence: presence(), stats: getStats() })}\n\n`);
      schedulePresence();
      req.on("close", () => {
        clients.delete(client);
        schedulePresence();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/judge") {
      if (!user) return send(res, 401, { error: "Join first" });
      if (!judgeBucket.take(uid)) return send(res, 429, { error: "Typing fast! Give Jev a second." });
      const { draft = "" } = await readJson(req);
      const verdict = await gatedJudge(String(draft).slice(0, MAX_TEXT), store.recent(3));
      return send(res, 200, { ...verdict, stats: getStats() });
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      if (!user) return send(res, 401, { error: "Join first" });
      if (!sendBucket.take(uid)) return send(res, 429, { error: "Whoa, one nice thing at a time!" });
      const { text = "" } = await readJson(req);
      const clean = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (!clean) return send(res, 400, { error: "Say something!" });
      // Always re-judge server-side (short drafts included): the client cannot bypass the gate.
      const verdict = await gatedJudge(clean, store.recent(3), { force: true });
      if (!verdict.allowed) return send(res, 403, { blocked: true, ...verdict, stats: getStats() });
      const msg = store.addMessage({
        id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
        name: user.name,
        emoji: user.emoji,
        text: clean,
        ts: Date.now(),
        niceness: verdict.niceness,
        tone: verdict.tone,
        kind: verdict.kind,
        scores: { flags: verdict.flags, tone_probs: verdict.tone_probs, niceness_probs: verdict.niceness_probs, latency_ms: verdict.latency_ms },
      });
      broadcast("message", { message: msg, fame: store.hallOfFame() });
      return send(res, 200, { ok: true, ...verdict, message: msg, stats: getStats() });
    }

    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, { ...getStats(), presence: presence(), messages: store.messageCount() });

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (e) {
    if (e.busy) return send(res, 503, { error: "Jev is swamped, try again in a moment", busy: true });
    console.error(`[${req.method} ${url.pathname}]`, e.message);
    if (!res.headersSent) send(res, 502, { error: String(e.message || e) });
  }
});

store.load();
server.listen(PORT, () => {
  console.log(`Nice Chat on http://localhost:${PORT}  model=${MODEL}  Jev key ${process.env.TYPESAFE_API_KEY ? "present" : "MISSING"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    store.save();
    process.exit(0);
  });
}
