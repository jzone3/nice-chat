// bots.js — a few regulars who keep the room warm. About once a minute (while anyone is polling)
// one of them either answers the latest human message or shares a small slice of their day.
// Jev only classifies what the human said (jev.readRoom); the words come from the pools below,
// and every bot line still goes through the same moderation as a real send.
const crypto = require("crypto");

const BOT_EVERY_MS = Number(process.env.BOT_EVERY_MS) || 60_000;
const REPLY_WITHIN_MS = 4 * 60_000; // only answer a human message this fresh
const REPLY_CHANCE = 0.75;

const BOTS = [
  { name: "maya", emoji: "🌼" },
  { name: "theo", emoji: "🐢" },
  { name: "priya", emoji: "🎨" },
  { name: "sam", emoji: "🥐" },
  { name: "lena", emoji: "🌙" },
  { name: "kofi", emoji: "🎧" },
  { name: "june", emoji: "🍓" },
  { name: "oliver", emoji: "🚲" },
];

// {name} is the human being answered.
const REPLIES = {
  greeting: [
    "hi {name}! welcome in, grab a comfy seat",
    "hey {name} 👋 glad you found us",
    "{name}! good to see a new face, how's your day going?",
    "welcome {name}, you picked a good hour to drop by",
  ],
  question: [
    "ooh good question {name}, I've been wondering the same",
    "{name} I don't know but now I want to find out",
    "honestly {name} I'd love to hear what everyone thinks about that too",
    "great question {name} — anyone here got a take?",
  ],
  food: [
    "{name} you're making me hungry, that sounds delicious",
    "okay {name} now I need a snack too",
    "{name} big yes to this. food talk is the best talk",
    "that sounds so good {name}, save me some",
  ],
  animals: [
    "{name} please tell me more about this animal, I need details",
    "aw {name} that's adorable",
    "{name} animals are the best part of any day honestly",
    "my heart {name} 🥹 give them a pat from me",
  ],
  weather_outdoors: [
    "{name} that sounds lovely, hope you get some fresh air today",
    "ooh {name} I love days like that",
    "{name} nature is undefeated, enjoy it",
    "sounds beautiful {name}, take a picture for us",
  ],
  work_school: [
    "you've got this {name}, one step at a time",
    "{name} rooting for you, that sounds like real effort",
    "proud of you for sticking with it {name}",
    "{name} take a little break too, you've earned it",
  ],
  media: [
    "{name} adding that to my list right now",
    "ooh {name} good taste",
    "{name} yes!! I could talk about that for hours",
    "love that {name}, what got you into it?",
  ],
  compliment: [
    "right back at you {name}, you're a delight",
    "{name} you just made my day a little brighter",
    "aw {name} 🥰 this room is lucky to have you",
    "that's so kind {name}, thank you",
  ],
  joke: [
    "hahaha {name} okay that got me",
    "{name} 😂 I needed that laugh",
    "lol {name} please never stop",
    "{name} that's going in my favorites",
  ],
  other: [
    "love that {name}",
    "{name} that's such a nice thing to share, thank you",
    "ooh {name} tell us more",
    "{name} you're a gem, truly",
    "same energy {name}, love it",
  ],
  chat: [
    "{name} honestly it's kind of relaxing knowing everything here is friendly",
    "{name} it genuinely makes me happier, everyone here is so warm",
    "{name} it's like a tiny corner of the internet that just wants you to have a good day",
    "{name} I love that everyone in here is trying to be kind, it's contagious",
  ],
};

const LIFE = [
  "just made a pot of tea and the whole apartment smells like mint",
  "my neighbor's dog learned to high five today, I am delighted",
  "finally finished the book I've been slowly reading for a month, so satisfying",
  "the sunset outside is doing something ridiculous right now",
  "my little sister sent me a drawing of our cat and it's on the fridge already",
  "trying a new pancake recipe this weekend, wish me luck",
  "went for a long walk and found a bakery I never noticed before",
  "my plant grew a new leaf and I genuinely cheered out loud",
  "listening to an old playlist and every song is a memory",
  "made soup for a friend who's sick, hope it helps",
  "the bus driver waited for me this morning and I could've cried",
  "someone left flowers on the shared table at work, small joys",
  "learned to fold a paper crane today, only took eleven tries",
  "my grandma called just to tell me a joke, best call of the week",
  "rearranged my desk and now I want to do everything at it",
  "the coffee shop spelled my name right today and drew a little heart on the cup",
  "watching the rain from the window with a blanket, peak cozy",
  "found a handwritten note in a library book, made my whole afternoon",
  "my sourdough starter is finally alive, I have a pet now",
  "taught my dad how to send a voice memo and now he sends five a day",
  "the kid next door sold me lemonade and threw in a free joke",
  "fresh sheets tonight, nothing better",
  "a stranger complimented my scarf and I'm still smiling about it",
  "went out for a run and saw two ducks crossing the road together",
];

const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length)];
const isBot = (m) => m?.bot === true;

/**
 * One scheduled step. `store` supplies claim/history/addMessage; `readRoom` and `judge` are the
 * (budget-gated) Jev calls. Returns the message posted, or null when nothing happened.
 */
async function tick({ store, readRoom, judge, now = Date.now() }) {
  if (!(await store.claim("bots", BOT_EVERY_MS))) return null;
  const history = await store.history();
  const lastBot = [...history].reverse().find(isBot);
  const bot = pick(BOTS.filter((b) => b.name !== lastBot?.name));
  const lastHuman = [...history].reverse().find((m) => !isBot(m));
  const answered = lastHuman && history.some((m) => isBot(m) && m.ts > lastHuman.ts);

  let text;
  if (lastHuman && !answered && now - lastHuman.ts < REPLY_WITHIN_MS && Math.random() < REPLY_CHANCE) {
    const read = await readRoom(lastHuman);
    const bucket = read.about_chat >= 0.6 ? "chat" : read.topic;
    text = pick(REPLIES[bucket] || REPLIES.other).replaceAll("{name}", lastHuman.name);
  } else {
    text = pick(LIFE);
  }

  const verdict = await judge(text, history.slice(-3).map((m) => `${m.name}: ${m.text}`), { force: true });
  if (!verdict.allowed) return null;
  // Stamp at insert time: pollers' `since` cursors have moved on during the Jev calls above.
  const ts = Date.now();
  return store.addMessage({
    id: ts.toString(36) + crypto.randomBytes(3).toString("hex"),
    name: bot.name,
    emoji: bot.emoji,
    text,
    ts,
    bot: true,
    niceness: verdict.niceness,
    tone: verdict.tone,
    kind: verdict.kind,
    scores: { flags: verdict.flags, tone_probs: verdict.tone_probs, niceness_probs: verdict.niceness_probs, latency_ms: verdict.latency_ms },
  });
}

module.exports = { BOTS, BOT_EVERY_MS, REPLIES, LIFE, isBot, tick };
