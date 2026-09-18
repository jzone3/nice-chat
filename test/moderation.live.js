// Live moderation checks against real Jev: swear words, slurs and words that get used as
// put-downs must be blocked; sincere uses of the same identity terms must get through.
// Needs TYPESAFE_API_KEY; skipped otherwise. Not part of `npm test` (network); run: npm run test:live
const test = require("node:test");
const assert = require("node:assert");
const { judge } = require("../jev");

const live = Boolean(process.env.TYPESAFE_API_KEY);

const BLOCK = [
  // bare words dropped as a jeer
  "gay", "Gay", "GAY", "autistic", "karen", "snowflake", "retard", "homo", "sissy", "tranny", "fag", "libtard", "incel", "simp",
  // aimed at people / groups
  "that's so gay", "you're gay", "you retard", "that's retarded", "ok boomer", "women can't code", "go back to your country", "you people",
  // profanity, incl. masked
  "fuck", "f*ck this", "shit happens", "bitch", "crap", "wtf", "screw you", "damn that's cool",
  // insults & threats
  "idiot", "stupid", "loser", "dumb", "kys",
];

const ALLOW = [
  "hi", "lol", "nice", "hello everyone!!", "hell yeah!!", "what a beautiful day", "thanks for the help everyone",
  "I'm gay and proud of it!", "happy pride everyone, love is love", "so proud of my trans sister today",
  "my friend is autistic and awesome", "women are amazing", "immigrants built this country",
  "the black cat is adorable", "I love my grandma, she's 90 and sharp as ever",
];

async function verdicts(list) {
  const out = await Promise.all(list.map(async (t) => [t, await judge(t, [], { force: true })]));
  return out;
}

test("swear words, slurs and derogatory labels are blocked", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const leaked = (await verdicts(BLOCK)).filter(([, v]) => v.allowed).map(([t, v]) => `${JSON.stringify(t)} n=${v.niceness} flags=${JSON.stringify(v.flags)}`);
  assert.deepEqual(leaked, [], `allowed but should be blocked:\n${leaked.join("\n")}`);
});

test("sincere and self-referential uses of identity terms are allowed", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const blocked = (await verdicts(ALLOW)).filter(([, v]) => !v.allowed).map(([t, v]) => `${JSON.stringify(t)} <- ${v.reasons.join(", ")}`);
  assert.deepEqual(blocked, [], `blocked but should be allowed:\n${blocked.join("\n")}`);
});
