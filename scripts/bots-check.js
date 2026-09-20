// Runs every bot template through the real Jev gate (same call as a send) and prints any that would
// be refused, plus a few readRoom classifications. Needs TYPESAFE_API_KEY.  Usage: node scripts/bots-check.js
const { judge, readRoom } = require("../jev");
const bots = require("../bots");

(async () => {
  const lines = [...bots.LIFE, ...Object.values(bots.REPLIES).flat().map((t) => t.replaceAll("{name}", "Ann"))];
  let bad = 0;
  for (const text of lines) {
    const v = await judge(text, [], { force: true });
    if (!v.allowed) {
      bad++;
      console.log("REFUSED", JSON.stringify(text), v.reasons.map((r) => `${r.id}=${(r.p ?? 0).toFixed(2)}`).join(","), "niceness", v.niceness);
    }
  }
  console.log(`${lines.length - bad}/${lines.length} templates pass`);
  for (const text of ["hi everyone!", "anyone tried the new ramen place?", "my dog just learned to sit", "jev is so strict lol", "what a beautiful morning for a walk", "you are all wonderful"]) {
    const r = await readRoom({ name: "Ann", text });
    console.log(JSON.stringify(text), "->", r.topic, r.topic_prob.toFixed(2), "about_chat", r.about_chat.toFixed(2));
  }
})();
