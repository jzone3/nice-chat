# 💖 Nice Chat

[Built by Devin](https://builtbydevin.ai/)

One big chat room. Everyone in the world. **Only nice messages get through.**

**Live at https://benicechat.com**

Every draft is scored by [Jev](https://docs.typesafe.ai) while you type, and again on the
server when you hit send. Mean messages never land — the Send button just wiggles
(harder the meaner you were) and tells you why.

## Features

- **Comic Sans + pastels.** Big friendly type, floaty pastel blobs, bouncy buttons.
- **Live niceness meter.** Jev reads your draft as you type; the face and meter react.
- **Scaled wiggle.** A blocked send shakes the button; amplitude, rotation and duration
  scale with Jev's `meanness` score. Truly hostile messages shake the whole page.
- **🐛 Debugger mode.** Flip the switch for hacker colors (black background, green
  monospace) and see every probability Jev returned — for your live draft *and* for
  every message in the room.
- **One massive room.** Server-Sent Events fan messages out to everyone connected,
  with presence, a "nicest things said" leaderboard, and live Jev stats.
- **Username + emoji.** Pick a name and an emoji to join. A cookie remembers you on
  that computer, so refreshing or coming back later drops you straight into the room.
- **Live-only thread.** You only see what's said while you're connected; a refresh
  starts with an empty thread. (The server keeps a short rolling buffer so pollers and
  reactions work, but no history is replayed to anyone.)

## How moderation works

Jev is not a text-generating LLM — it returns calibrated probabilities that code can
branch on. Each check is **one request with ten atomic questions** about the draft
(plus the last few room messages for context):

| id | type | question |
| --- | --- | --- |
| `is_kind` | Noul | Is it kind or friendly? |
| `is_insult` | Noul | Does it insult or demean someone? |
| `is_sarcastic_or_backhanded` | Noul | Sarcastic, mocking or a backhanded compliment? |
| `is_passive_aggressive` | Noul | Passive-aggressive or guilt-tripping? |
| `is_profane_or_slur` | Noul | Profanity or slurs? |
| `is_disguised_slur` | Noul | Does any token decode to a slur or swear once you read leetspeak / symbols / split letters ("solve for k1k3", "f a g")? Plain identifiers like `k1`, `k3` don't. |
| `is_derogatory_label` | Noul | A word used as a put-down / jeer (a bare "gay", "karen", "that's so autistic")? Sincere uses ("I'm gay and proud") are not. |
| `is_hateful` | Noul | Contempt or stereotypes aimed at a group? |
| `is_harassment_or_threat` | Noul | Harassing or threatening? |
| `tone` | Choice | warm / neutral / cold / hostile |
| `niceness` | Score | 1 (mean) … 5 (lovely) |

Plain code in [`jev.js`](jev.js) owns the thresholds and the final decision, and derives a
0–1 `meanness` score that drives the wiggle. The browser calls `/api/judge` for the live
preview, but `/api/send` always re-judges on the server, so nothing sneaks past.

## Run it

Requires Node 20+. No dependencies.

```bash
export TYPESAFE_API_KEY=...   # get one at https://console.typesafe.ai
npm start                     # http://localhost:3000
```

Optional env vars (see [`.env.example`](.env.example)): `PORT`, `JEV_MODEL`, `DATA_FILE`,
`MAX_MESSAGES`, `HISTORY`, `MAX_TEXT` (default 280), `MAX_JEV_INFLIGHT`, `JEV_BUDGET_30M` (room-wide Jev
calls per 30 min, default 3000), `TRUST_PROXY` (set to `0` when not behind a reverse proxy),
`REDIS_URL` (use a shared Redis instead of the JSON file), `TRANSPORT` (`sse` or `poll`), `POLL_MS`.

```bash
npm run check   # syntax-check every file
npm test        # decision-logic + store tests (no network)
npm run test:live  # real-Jev moderation set: swear words, slurs, put-downs blocked; sincere identity talk allowed
npm run probe -- "some text" "other text"   # print Jev's verdict + top probabilities for any drafts
```

### Docker

```bash
docker build -t nice-chat .
docker run -p 3000:3000 -e TYPESAFE_API_KEY=... -v nice-chat-data:/data nice-chat
```

### Vercel

The app runs as a single serverless function (`api/index.js`) plus static files. Because
instances come and go, the room needs a shared Redis and browsers poll instead of
holding an SSE stream (both switch on automatically when `VERCEL` is set).

```bash
vercel link
vercel integration add upstash          # Upstash for Redis → sets REDIS_URL on the project
vercel env add TYPESAFE_API_KEY production --sensitive
vercel deploy --prod
```

Without `REDIS_URL` the function falls back to in-memory state, which is fine for a demo
but resets on cold starts and isn't shared between instances.

## Architecture

```
public/            static frontend (index.html, style.css, app.js) — no build step
handler.js         the request handler: static files, cookies, routes, rate limits, SSE or poll
server.js          long-running Node entry (local / Docker): http.createServer(handle)
api/index.js       Vercel function entry (all /api/* and /healthz are rewritten here)
jev.js             Jev questions, thresholds, decide(), cache, retries, stats
store.js           async room store: memory+JSON file, or Redis when REDIS_URL is set
redis.js           ~150-line zero-dependency RESP client (redis:// and rediss://, pipelining)
test/              node:test suite for decide(), the RESP parser and the store
```

Endpoints: `GET /api/me` (also tells the browser which transport to use), `POST /api/join`,
`GET /api/stream` (SSE, long-running mode), `GET /api/poll?since=<ts>` (serverless mode;
doubles as presence heartbeat), `POST /api/judge`, `POST /api/send`, `GET /api/stats`, `GET /healthz`.

Public-room safeguards: 280-char messages (rejected, not truncated), layered fixed-window
rate limits — burst + sustained per user for typing checks / sends / reactions, per IP for
typing checks / sends / joins so clearing cookies doesn't reset them — a room-wide budget of
Jev calls per 30 minutes (only real upstream calls count; skipped and cached drafts are free;
when it runs out the room answers 503 "cooling down" instead of calling Jev), a cap on
in-flight Jev calls per instance, bounded history, and an exact-state Jev cache. With Redis, users,
messages, hall of fame, presence, rate limits and Jev stats are all shared, so any number of instances serve the same room.

---

Made with 💖 · [Built by Devin](https://builtbydevin.ai/)
