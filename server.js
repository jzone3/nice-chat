// Nice Chat server: one big room, zero dependencies. Long-running Node process (local, Docker, any VM).
const http = require("http");
const { handle, store, TRANSPORT, MODEL } = require("./handler");

const PORT = Number(process.env.PORT) || 3000;

store.load();
http.createServer(handle).listen(PORT, () => {
  console.log(
    `Nice Chat on http://localhost:${PORT}  model=${MODEL}  store=${store.kind}  transport=${TRANSPORT}  Jev key ${process.env.TYPESAFE_API_KEY ? "present" : "MISSING"}`
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    store.save();
    process.exit(0);
  });
}
