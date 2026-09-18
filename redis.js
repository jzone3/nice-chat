// redis.js — tiny zero-dependency RESP2 client (redis:// and rediss://) with pipelining.
// One lazy connection per process; commands queue while (re)connecting.
const net = require("net");
const tls = require("tls");

const CMD_TIMEOUT_MS = 5000;

class RedisError extends Error {}

class Redis {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port) || 6379;
    this.tls = u.protocol === "rediss:";
    this.user = decodeURIComponent(u.username || "");
    this.pass = decodeURIComponent(u.password || "");
    this.db = Number(u.pathname.slice(1)) || 0;
    this.sock = null;
    this.connecting = null;
    this.buf = Buffer.alloc(0);
    this.pending = []; // { resolve, reject, timer }
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const sock = this.tls ? tls.connect({ ...opts, servername: this.host }) : net.connect(opts);
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 15_000);
      const onReady = async () => {
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        try {
          if (this.pass) await this.exec(this.user ? ["AUTH", this.user, this.pass] : ["AUTH", this.pass]);
          if (this.db) await this.exec(["SELECT", String(this.db)]);
          resolve();
        } catch (e) {
          sock.destroy();
          reject(e);
        } finally {
          this.connecting = null;
        }
      };
      sock.once(this.tls ? "secureConnect" : "connect", onReady);
      sock.on("data", (chunk) => this.onData(chunk));
      const fail = (err) => {
        const e = err || new RedisError("connection closed");
        if (this.sock === sock) this.sock = null;
        this.connecting = null;
        for (const p of this.pending.splice(0)) p.reject(e);
        reject(e);
      };
      sock.on("error", fail);
      sock.on("close", () => fail());
    });
    return this.connecting;
  }

  // Send one command, get one reply.
  async exec(args) {
    const [r] = await this.pipeline([args]);
    if (r instanceof Error) throw r;
    return r;
  }

  // Send many commands in one write; resolves to an array of replies (errors are returned inline as Error).
  async pipeline(cmds) {
    if (!this.sock || this.sock.destroyed) await this.connect();
    const sock = this.sock;
    const out = [];
    for (const args of cmds) {
      out.push(`*${args.length}\r\n`);
      for (const a of args) {
        const s = Buffer.from(String(a));
        out.push(`$${s.length}\r\n`, s, "\r\n");
      }
    }
    const replies = cmds.map(
      () =>
        new Promise((resolve, reject) => {
          const p = { resolve, reject, timer: null };
          p.timer = setTimeout(() => {
            const i = this.pending.indexOf(p);
            if (i >= 0) this.pending.splice(i, 1);
            reject(new RedisError("redis timeout"));
            sock.destroy();
          }, CMD_TIMEOUT_MS);
          this.pending.push(p);
        })
    );
    sock.write(Buffer.concat(out.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))));
    return Promise.all(replies.map((p) => p.catch((e) => e)));
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const r = parse(this.buf, 0);
      if (!r) return;
      this.buf = this.buf.subarray(r.end);
      const p = this.pending.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      p.resolve(r.value);
    }
  }
}

// Returns { value, end } or null when the buffer holds an incomplete reply.
function parse(buf, i) {
  if (i >= buf.length) return null;
  const nl = buf.indexOf("\r\n", i);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString("utf8", i + 1, nl);
  const after = nl + 2;
  switch (type) {
    case "+":
      return { value: line, end: after };
    case "-":
      return { value: new RedisError(line), end: after };
    case ":":
      return { value: Number(line), end: after };
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, end: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), end: after + len + 2 };
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return { value: null, end: after };
      const items = [];
      let pos = after;
      for (let k = 0; k < n; k++) {
        const r = parse(buf, pos);
        if (!r) return null;
        items.push(r.value);
        pos = r.end;
      }
      return { value: items, end: pos };
    }
    default:
      throw new RedisError(`bad RESP type ${JSON.stringify(type)}`);
  }
}

module.exports = { Redis, RedisError };
