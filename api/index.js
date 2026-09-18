// Vercel serverless entry: every /api/* and /healthz request lands here (see vercel.json). Static files come from public/.
const { handle, store } = require("../handler");

store.load();
module.exports = handle;
