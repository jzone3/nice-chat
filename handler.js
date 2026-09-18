// handler.js — the Nice Chat request handler, shared by server.js (long-running Node, SSE fan-out)
// and api/index.js (Vercel serverless, clients poll a shared Redis-backed store).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { judge, MODEL } = require("./jev");
const store = require("./store");

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
// Behind a reverse proxy (most hosts), X-Forwarded-* is the only source of client IP/proto.
// Set TRUST_PROXY=0 when exposing the Node process directly so clients cannot spoof them.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
// "sse": one process pushes to every open stream. "poll": stateless instances, browsers poll /api/poll.
const TRANSPORT = process.env.TRANSPORT || (process.env.VERCEL ? "poll" : "sse");
const POLL_MS = Number(process.env.POLL_MS) || 2500;

// ------------------------------------------------------------------ helpers
function readJson(req) {
  // Vercel's Node helpers pre-read the body into req.body; plain Node leaves it on the stream.
  if (req.body !== undefined) {
    if (typeof req.body === "object" && req.body !== null) return Promise.resolve(req.body);
    try {
      return Promise.resolve(JSON.parse(req.body || "{}"));
    } catch (e) {
      e.badRequest = true;
      return Promise.reject(e);
    }
  }
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
        e.badRequest = true;
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
  return (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https") || req.socket.encrypted;
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
  const fwd = TRUST_PROXY ? req.headers["x-forwarded-for"] : undefined;
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

let jevInflight = 0;
async function gatedJudge(...args) {
  if (jevInflight >= MAX_JEV_INFLIGHT) {
    const err = new Error("busy");
    err.busy = true;
    throw err;
  }
  jevInflight++;
  try {
    const verdict = await judge(...args);
    if (!verdict.cached && !verdict.skipped) await store.bumpStats({ blocked: !verdict.allowed, latency_ms: verdict.latency_ms });
    return verdict;
  } finally {
    jevInflight--;
  }
}

async function stats() {
  return { ...(await store.stats()), model: MODEL };
}

function publicUser(u) {
  return u ? { name: u.name, emoji: u.emoji } : null;
}

// ---------------------------------------------------------------- realtime (sse transport only)
const clients = new Set(); // { res, uid }
const MAX_SSE_BUFFER = 256 * 1024; // drop clients that stop reading
function push(c, payload) {
  if (c.res.destroyed || c.res.writableLength > MAX_SSE_BUFFER) {
    clients.delete(c);
    c.res.destroy();
    return;
  }
  c.res.write(payload);
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) push(c, payload);
}

// Background store calls (timers, close handlers) run outside any request's try/catch.
const logFail = (what) => (e) => console.error(`[${what}]`, e.message);

let presenceTimer = null;
function schedulePresence() {
  if (TRANSPORT !== "sse" || presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    store.presence().then((p) => broadcast("presence", p), logFail("presence"));
  }, 300);
}

if (TRANSPORT === "sse") {
  setInterval(() => {
    for (const c of clients) {
      push(c, ": ping\n\n");
      store.heartbeat(c.uid).catch(logFail("heartbeat"));
    }
  }, 25_000).unref();
}

// ------------------------------------------------------------------ handler
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const cookies = parseCookies(req);
  const uid = cookies[COOKIE] && /^[a-f0-9-]{36}$/.test(cookies[COOKIE]) ? cookies[COOKIE] : null;

  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      const [p, n] = await Promise.all([store.presence(), store.messageCount()]);
      return send(res, 200, { ok: true, online: p.online, messages: n, store: store.kind, transport: TRANSPORT, jev_key: Boolean(process.env.TYPESAFE_API_KEY) });
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const p = path.resolve(PUBLIC, file);
      const ext = path.extname(p);
      if (!p.startsWith(PUBLIC + path.sep) || !MIME[ext] || !fs.existsSync(p)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-cache" });
      return fs.createReadStream(p).pipe(res);
    }

    const user = await store.getUser(uid);

    if (req.method === "GET" && url.pathname === "/api/me") {
      return send(res, 200, { user: publicUser(user), transport: TRANSPORT, poll_ms: POLL_MS, shared: store.shared });
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      if (!(await store.allow("join", clientIp(req)))) return send(res, 429, { error: "Slow down a little" });
      const prof = cleanProfile(await readJson(req));
      if (prof.error) return send(res, 400, { error: prof.error });
      const id = uid || crypto.randomUUID();
      const u = await store.upsertUser(id, prof);
      await store.heartbeat(id);
      schedulePresence();
      return send(res, 200, { user: publicUser(u) }, setUidCookie(req, id));
    }

    // Poll transport: initial call (no `since`) returns history; later calls return what's new. Doubles as presence heartbeat.
    // A delta that fills the whole HISTORY window may have skipped messages, so it is sent as a full refresh instead.
    if (req.method === "GET" && url.pathname === "/api/poll") {
      const since = Number(url.searchParams.get("since")) || 0;
      if (user) await store.heartbeat(uid);
      let [messages, fame, presence, s] = await Promise.all([since ? store.since(since) : store.history(), store.hallOfFame(), store.presence(), stats()]);
      let full = !since;
      if (!full && messages.length >= store.HISTORY) {
        messages = await store.history();
        full = true;
      }
      return send(res, 200, { now: Date.now(), full, messages, fame, presence, stats: s });
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      if (TRANSPORT !== "sse") return send(res, 404, { error: "streaming is off here; use /api/poll" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const client = { res, uid: user ? uid : null };
      clients.add(client);
      if (user) await store.heartbeat(uid);
      const [messages, fame, presence, s] = await Promise.all([store.history(), store.hallOfFame(), store.presence(), stats()]);
      res.write(`retry: 3000\n`);
      res.write(`event: history\ndata: ${JSON.stringify({ messages, fame, presence, stats: s })}\n\n`);
      schedulePresence();
      req.on("close", () => {
        clients.delete(client);
        if (client.uid && ![...clients].some((c) => c.uid === client.uid)) store.leave(client.uid).catch(logFail("leave"));
        schedulePresence();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/judge") {
      if (!user) return send(res, 401, { error: "Join first" });
      if (!(await store.allow("judge", uid))) return send(res, 429, { error: "Typing fast! Give Jev a second." });
      const { draft = "" } = await readJson(req);
      const verdict = await gatedJudge(String(draft).slice(0, MAX_TEXT), await store.recent(3));
      return send(res, 200, { ...verdict, stats: await stats() });
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      if (!user) return send(res, 401, { error: "Join first" });
      if (!(await store.allow("send", uid))) return send(res, 429, { error: "Whoa, one nice thing at a time!" });
      const { text = "" } = await readJson(req);
      const clean = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (!clean) return send(res, 400, { error: "Say something!" });
      // Always re-judge server-side (short drafts included): the client cannot bypass the gate.
      const verdict = await gatedJudge(clean, await store.recent(3), { force: true });
      if (!verdict.allowed) return send(res, 403, { blocked: true, ...verdict, stats: await stats() });
      const msg = await store.addMessage({
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
      const fame = await store.hallOfFame();
      if (TRANSPORT === "sse") broadcast("message", { message: msg, fame });
      return send(res, 200, { ok: true, ...verdict, message: msg, fame, stats: await stats() });
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const [s, presence, messages] = await Promise.all([stats(), store.presence(), store.messageCount()]);
      return send(res, 200, { ...s, presence, messages });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (e) {
    if (e.busy) return send(res, 503, { error: "Jev is swamped, try again in a moment", busy: true });
    if (e.badRequest) return send(res, 400, { error: "Bad JSON" });
    console.error(`[${req.method} ${url.pathname}]`, e.message);
    if (!res.headersSent) send(res, 502, { error: String(e.message || e) });
  }
}

module.exports = { handle, store, TRANSPORT, MODEL };
