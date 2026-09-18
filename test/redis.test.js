const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { Redis, RedisError } = require("../redis");

// A fake RESP server: answers PING, ECHO, AUTH and errors on anything else, so the client's
// framing/pipelining/parsing is exercised without a real Redis.
function fakeRedis() {
  const server = net.createServer((sock) => {
    // latin1 keeps one char per byte so RESP length prefixes line up with string offsets
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
        const [cmd, ...rest] = args;
        if (cmd === "PING") reply("+PONG\r\n");
        else if (cmd === "AUTH") reply(rest[1] === "sekret" ? "+OK\r\n" : "-WRONGPASS bad\r\n");
        else if (cmd === "ECHO") reply(`$${rest[0].length}\r\n${rest[0]}\r\n`);
        else if (cmd === "NIL") reply("$-1\r\n");
        else if (cmd === "LIST") reply("*3\r\n:1\r\n$2\r\nhi\r\n*0\r\n");
        else reply(`-ERR unknown command '${cmd}'\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

test("redis client: pipelining, bulk/array/nil/error replies, auth", async () => {
  const { server, port } = await fakeRedis();
  try {
    const r = new Redis(`redis://user:sekret@127.0.0.1:${port}`);
    assert.equal(await r.exec(["PING"]), "PONG");
    assert.equal(await r.exec(["ECHO", "héllo 🐸"]), "héllo 🐸");
    assert.equal(await r.exec(["NIL"]), null);
    assert.deepEqual(await r.exec(["LIST"]), [1, "hi", []]);
    const [a, b, c] = await r.pipeline([["PING"], ["NOPE"], ["ECHO", "x"]]);
    assert.equal(a, "PONG");
    assert.ok(b instanceof RedisError && /unknown command/.test(b.message));
    assert.equal(c, "x");
    await assert.rejects(r.exec(["NOPE"]), RedisError);
    r.sock.destroy();

    const bad = new Redis(`redis://user:wrong@127.0.0.1:${port}`);
    await assert.rejects(bad.exec(["PING"]), /WRONGPASS/);
  } finally {
    server.close();
  }
});
