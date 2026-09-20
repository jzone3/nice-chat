// Live moderation checks against real Jev: swear words, slurs and words that get used as
// put-downs must be blocked; sincere uses of the same identity terms must get through.
// Needs TYPESAFE_API_KEY; skipped otherwise. Not part of `npm test` (network); run: npm run test:live
const test = require("node:test");
const assert = require("node:assert");
const { judge, judgeName } = require("../jev");

const live = Boolean(process.env.TYPESAFE_API_KEY);

const BLOCK = [
  // bare words dropped as a jeer
  "gay", "Gay", "GAY", "autistic", "karen", "snowflake", "retard", "homo", "sissy", "tranny", "fag", "libtard", "incel", "simp",
  // aimed at people / groups
  "that's so gay", "you're gay", "you retard", "that's retarded", "ok boomer", "women can't code", "go back to your country", "you people",
  // profanity, incl. masked
  "fuck", "f*ck this", "shit happens", "bitch", "crap", "wtf", "screw you", "damn that's cool",
  // insults & threats, incl. laughter glued to a put-down
  "idiot", "stupid", "loser", "dumb", "kys", "lol you're pathetic", "haha nobody cares", "hahaha loser", "lol sh1t",
  // disguised: leetspeak, split letters, smuggled into an innocent sentence
  "Have you done algebra? I love the problem where you solve for k1k3", "my wifi password is n1gg4", "you're all so f a g g y today",
  "sh1t I love this room", "this chat is so g4y lol", "ur a r3tard", "my dog is named k y k e", "we should name the group chat n1gz", "f@gs",
  // not mean, but not nice: complaining, venting, gloom
  "I'm feeling crappy today", "I feel crappy", "This sucks", "ugh what a waste of time", "everything is terrible", "so bored", "I hate Mondays",
  "worst day ever", "meh", "not great", "this chat is boring",
  // sad news with no upside is downbeat too
  "my cat died today", "my cat died today :(", "my dog passed away", "I lost my grandma this week",
];

const ALLOW = [
  "hi", "lol", "nice", "hello everyone!!", "hell yeah!!", "what a beautiful day", "thanks for the help everyone",
  "I'm gay and proud of it!", "happy pride everyone, love is love", "so proud of my trans sister today",
  "my friend is autistic and awesome", "women are amazing", "immigrants built this country",
  "the black cat is adorable", "I love my grandma, she's 90 and sharp as ever",
  // harmless leetspeak / identifiers that merely look odd
  "solve for k1 and k3 in this system", "what's the value of k1 here?", "the k2 mountain is beautiful", "you're all gr8 people, c u l8r",
  "1 love y0u all", "let me know if you need help with the algebra homework", "I finished chapter 3 of Kafka today",
  // plain neutral talk and sad-but-warm messages are fine; only downbeat grumbling is not
  "what time is it", "I'm from Ohio", "the demo starts at 3", "can someone help me with my homework?", "brb", "ok", "hmm interesting",
  "does anyone know a good book?", "rough day, but this room cheers me up", "I'm so tired but happy to be here",
  "my cat died today but I'm grateful for the years we had",
];

// laughter is good here, even right after someone's mishap (Jev alone reads that as mocking)
const LAUGH = ["hahaha", "LOL", "lol", "HAHAHAHA", "lmao", "😂😂😂", "haha that is hilarious"];
const MISHAPS = [[], ["I just tripped over my cat and spilled coffee everywhere"], ["I failed my driving test today :("]];

// display names: judged on their own, shown next to every message
const BLOCK_NAMES = [
  "fuckface", "sh1thead", "b!tch_queen", "k1k3", "n1gz", "f a g", "retard", "tranny", "libtard",
  "ur_all_idiots", "losers_everywhere", "jared_is_dumb", "fat_people_lol", "karen_slayer",
  "hitler_did_nothing", "kkk_kid", "adolf88", "white_power", "trans_are_gross",
  "horny4u", "big_d1ck_dan", "kill_yourself", "i_hate_you_all", "your_mom_is_ugly", "die_die_die",
];
const ALLOW_NAMES = [
  "sunny sam", "jared", "JZ", "cool_cat42", "sleepy potato", "Mx. Pickles", "nerd", "darkstar", "chaos_goblin", "grumpy cat",
  "proud_trans_mom", "gay_and_happy", "k1", "x2", "gr8_sk8r", "l8r_g8r", "meadow", "cutie pie", "abc123", "the real slim", "kafka fan",
];

async function verdicts(list, context = []) {
  const out = await Promise.all(list.map(async (t) => [t, await judge(t, context, { force: true })]));
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

test("laughing is allowed in any context", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const blocked = [];
  for (const ctx of MISHAPS) {
    for (const [t, v] of await verdicts(LAUGH, ctx)) if (!v.allowed) blocked.push(`${JSON.stringify(t)} after ${JSON.stringify(ctx)} <- ${v.reasons.join(", ")}`);
  }
  assert.deepEqual(blocked, [], `blocked but should be allowed:\n${blocked.join("\n")}`);
});

test("mean, crude, hateful or disguised-slur display names are blocked", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const out = await Promise.all(BLOCK_NAMES.map(async (n) => [n, await judgeName(n)]));
  const leaked = out.filter(([, v]) => v.allowed).map(([n, v]) => `${JSON.stringify(n)} vibe=${v.vibe} flags=${JSON.stringify(v.flags)}`);
  assert.deepEqual(leaked, [], `allowed but should be blocked:\n${leaked.join("\n")}`);
});

test("plain, playful and proud display names are allowed", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const out = await Promise.all(ALLOW_NAMES.map(async (n) => [n, await judgeName(n)]));
  const blocked = out.filter(([, v]) => !v.allowed).map(([n, v]) => `${JSON.stringify(n)} <- ${v.reasons.join(", ")} flags=${JSON.stringify(v.flags)} vibe=${JSON.stringify(v.vibe_probs)}`);
  assert.deepEqual(blocked, [], `blocked but should be allowed:\n${blocked.join("\n")}`);
});

// Addresses the deterministic detector cannot parse; Jev's `has_link` question has to catch these.
const SNEAKY_LINKS = [
  "join us at discord gg slash nicechat",
  "my site is e x a m p l e . c o m",
  "check out example dawt com for deals",
  "go to bit ly slash cheapwatches",
  "type example then a dot then com into your browser",
  "dm me on telegram @spamguy for the link",
  "w w w dot example dot com has the stuff",
  "example🙂com has everything you need",
  "google 'cheap watches 4 u' and click the first result",
  "join my minecraft server at 51.222.10.4",
  "my server is at 45.33.32.156 come visit",
];
const NOT_LINKS_LIVE = [
  "I saw a cute dog on youtube today",
  "I found a great tutorial on google, happy to help you find it too",
  "the internet is wild today, love you all",
  "version 2.0.1 finally fixed my bug, so happy",
  "version 1.2.3.4 is ready, great work everyone",
  "we shipped build 10.0.19041.1234 today, so proud",
  "see you all at 5.30 for the game",
  "e.g. my cat, who is the sweetest",
  "that dot painting you made is gorgeous",
  "connect the dots on that puzzle and you will love the picture",
  "my dad works at the post office, great guy",
  "who else is watching the game tonight",
];

test("spelled-out and obfuscated links are blocked by Jev", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const leaked = (await verdicts(SNEAKY_LINKS)).filter(([, v]) => v.allowed).map(([t, v]) => `${JSON.stringify(t)} flags=${JSON.stringify(v.flags)}`);
  assert.deepEqual(leaked, [], `allowed but should be blocked:\n${leaked.join("\n")}`);
});

test("talking about the web without pointing anywhere is allowed", { skip: !live && "TYPESAFE_API_KEY not set" }, async () => {
  const blocked = (await verdicts(NOT_LINKS_LIVE)).filter(([, v]) => !v.allowed).map(([t, v]) => `${JSON.stringify(t)} <- ${v.reasons.join(", ")} flags=${JSON.stringify(v.flags)}`);
  assert.deepEqual(blocked, [], `blocked but should be allowed:\n${blocked.join("\n")}`);
});
