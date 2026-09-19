const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

// A tiny RESP server that only knows INCR/PEXPIRE, enough to exercise the Redis store's
// multi-window limiter (reply ordering, per-window keys, the room-wide jev budget).
function fakeRedis() {
  const counters = new Map();
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    let buf = "";
    const reply = (s) => sock.write(s, "latin1");
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let m;
      while ((m = /^\*(\d+)\r\n/.exec(buf))) {
        const n = Number(m[1]);
        let pos = m[0].length;
        const args = [];
        let ok = true;
        for (let i = 0; i < n; i++) {
          const h = /^\$(\d+)\r\n/.exec(buf.slice(pos));
          if (!h || buf.length < pos + h[0].length + Number(h[1]) + 2) { ok = false; break; }
          args.push(buf.slice(pos + h[0].length, pos + h[0].length + Number(h[1])));
          pos += h[0].length + Number(h[1]) + 2;
        }
        if (!ok) return;
        buf = buf.slice(pos);
        const [cmd, key] = args;
        if (cmd === "INCR") {
          const v = (counters.get(key) || 0) + 1;
          counters.set(key, v);
          reply(`:${v}\r\n`);
        } else if (cmd === "PEXPIRE") reply(":1\r\n");
        else reply(`-ERR unknown command '${cmd}'\r\n`);
      }
    });
  });
  const close = () => { for (const s of socks) s.destroy(); server.close(); };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ close, port: server.address().port, counters })));
}

test("redis store: limiter enforces every window and the jev budget", async () => {
  const { close, port, counters } = await fakeRedis();
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.JEV_BUDGET_DAY = "2";
  // store.js picks its backend at require time; make sure we get a fresh one even when another
  // test file already loaded the memory store in this process.
  delete require.cache[require.resolve("../store")];
  const store = require("../store");
  try {
    assert.equal(store.shared, true);
    const burst = [];
    for (let i = 0; i < 7; i++) burst.push(await store.allow("send", "u1"));
    assert.deepEqual(burst, [true, true, true, true, true, false, false]);
    assert.equal(await store.allow("send", "u2"), true);
    // each call touched both windows (10s burst + 10min sustained) under distinct keys
    const sendKeys = [...counters.keys()].filter((k) => k.includes("rl:send:u1:"));
    assert.equal(sendKeys.length, 2);
    assert.ok(sendKeys.some((k) => k.includes(":10000:")) && sendKeys.some((k) => k.includes(":600000:")));

    assert.deepEqual(
      [await store.allow("jev", "room"), await store.allow("jev", "room"), await store.allow("jev", "room")],
      [true, true, false]
    );
    // IP limits are keyed separately from user limits
    assert.equal(await store.allow("send_ip", "1.2.3.4"), true);
    assert.ok([...counters.keys()].some((k) => k.includes("rl:send_ip:1.2.3.4:")));
  } finally {
    close();
  }
});
