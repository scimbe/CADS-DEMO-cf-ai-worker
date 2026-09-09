const ws = new WebSocket("ws://localhost:8990/agents/salon-agent/default?name=default");

ws.addEventListener("open", () => {
  console.log("connected");
  ws.send(JSON.stringify({ type: "text_message", text: "Haben Sie morgen um 14 Uhr einen Termin zum Schneiden frei?" }));
});

ws.addEventListener("message", (event) => {
  console.log("MSG:", typeof event.data === "string" ? event.data : "<binary>");
});

ws.addEventListener("error", (e) => console.log("ERROR", e.message ?? e));
ws.addEventListener("close", (e) => {
  console.log("closed", e.code, e.reason);
  process.exit(0);
});

setTimeout(() => {
  console.log("timeout, closing");
  ws.close();
  process.exit(0);
}, 20000);
