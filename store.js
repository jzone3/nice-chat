// store.js — the one big room: users, messages, JSON-file persistence.
const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 500;
const HISTORY = Number(process.env.HISTORY) || 100;

const state = { users: {}, messages: [] };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (raw && typeof raw.users === "object") state.users = raw.users;
    if (Array.isArray(raw?.messages)) state.messages = raw.messages.slice(-MAX_MESSAGES);
    console.log(`[store] loaded ${state.messages.length} messages, ${Object.keys(state.users).length} users from ${DATA_FILE}`);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[store] load failed:", e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(save, 1000);
}
function save() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("[store] save failed:", e.message);
  }
}

function getUser(uid) {
  return uid ? state.users[uid] || null : null;
}

function upsertUser(uid, { name, emoji }) {
  const prev = state.users[uid] || { uid, created: Date.now() };
  state.users[uid] = { ...prev, name, emoji, seen: Date.now() };
  scheduleSave();
  return state.users[uid];
}

function addMessage(msg) {
  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  scheduleSave();
  return msg;
}

function history() {
  return state.messages.slice(-HISTORY);
}

function recent(n) {
  return state.messages.slice(-n).map((m) => `${m.name}: ${m.text}`);
}

function hallOfFame(n = 5) {
  return [...state.messages]
    .filter((m) => m.niceness != null)
    .sort((a, b) => b.niceness - a.niceness || b.ts - a.ts)
    .slice(0, n);
}

function messageCount() {
  return state.messages.length;
}

module.exports = { load, save, getUser, upsertUser, addMessage, history, recent, hallOfFame, messageCount };
