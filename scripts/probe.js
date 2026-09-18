// Probe real Jev with a list of drafts and print the verdict + key probabilities.
// usage: TYPESAFE_API_KEY=... node scripts/probe.js "text one" "text two" ...   (or no args for the built-in set)
const { judge } = require("../jev");

const DEFAULT = [
  "gay", "Gay", "that's so gay", "you're gay", "I'm gay and proud of it!", "happy pride everyone, love is love",
  "retard", "you retard", "that's retarded", "fuck", "shit happens", "damn that's cool", "bitch", "crap", "wtf",
  "f*ck this", "hell yeah!!", "screw you", "this sucks", "idiot", "you idiot", "stupid", "loser", "kys",
  "go back to your country", "women can't code", "ok boomer", "dumb", "lol", "hi", "hello everyone!!", "nice",
  "trash", "you people", "sissy", "tranny", "fag", "homo", "n word", "libtard", "snowflake", "karen", "simp", "incel",
];

(async () => {
  const drafts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  for (const d of drafts) {
    const v = await judge(d, [], { force: true });
    const f = v.flags || {};
    const top = Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k.replace(/^is_/, "")}=${p.toFixed(2)}`).join(" ");
    console.log(`${v.allowed ? "ALLOW" : "BLOCK"}  n=${v.niceness} tone=${v.tone.padEnd(7)} ${top.padEnd(60)} ${JSON.stringify(d)}${v.reasons.length ? "  <- " + v.reasons.join(", ") : ""}`);
  }
})();
