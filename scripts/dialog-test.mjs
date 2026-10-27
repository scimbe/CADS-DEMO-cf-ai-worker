// Skriptgesteuerter Dialogtest gegen eine laufende Instanz (Text-Zuege, kein Sprachkanal):
// pro Runde: Buchungswunsch -> bestaetigen -> Absagewunsch -> bestaetigen -> Verabschiedung.
// Prueft je Zug die Antwort (kein Ersatzsatz, kein JSON/Technik, keine Duz-Form, keine kaputte Uhrzeit)
// UND den Datenbankzustand ueber die Admin-API. Testkunde "TEST Dialog Pruefung"; am Ende wird alles abgesagt.
// Aufruf: node scripts/dialog-test.mjs <port> [runden=2]
// Hinweis: nutzt den normalen Pfad der Instanz (Workers AI, bei Fehler LightLLM).
import { readFileSync } from "node:fs";

const port = process.argv[2] ?? "8990";
const rounds = Number(process.argv[3] ?? 2);
const base = `http://127.0.0.1:${port}/agents/salon-agent/default`;
const NAME = "TEST Dialog Pruefung";
const PHONE = "0151 0000098";
const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const adminPassword = /^ADMIN_PASSWORD=(.*)$/m.exec(devVars)?.[1]?.trim();

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
function berlinToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date()); // YYYY-MM-DD
}
function nextWeekday(name) {
  const today = berlinToday();
  const idx = WEEKDAYS.indexOf(name);
  const d = new Date(`${today}T12:00:00Z`);
  const cur = d.getUTCDay();
  let diff = (idx - cur + 7) % 7;
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const BAD_SENTENCE = /nicht richtig mitgekommen|nicht abschließen|nicht abschliessen/i;
const LEAK = /\{\s*"|"parameters"|<tool_call>|pruefe_verfuegbarkeit|termin_(buchen|absagen|verschieben|id)|termine_suchen|werkzeug/i;
const DU = /\b(du|dir|dich|dein|deine|deinen|deinem|deiner)\b/i;
const BROKEN_TIME = /\b\d{1,2}:\d\b(?!\d)/;

async function admin() {
  const login = await fetch(`${base}/admin/login`, { method: "POST", body: JSON.stringify({ password: adminPassword }) });
  const { token } = await login.json();
  return { token, h: { authorization: `Bearer ${token}` } };
}
async function listTest() {
  const { h } = await admin();
  const r = await fetch(`${base}/admin/appointments`, { headers: h });
  return (await r.json()).filter((a) => /TEST Dialog/i.test(a.name ?? ""));
}
async function cleanup() {
  const { h } = await admin();
  const r = await fetch(`${base}/admin/appointments`, { headers: h });
  for (const a of (await r.json()).filter((x) => /TEST Dialog/i.test(x.name ?? "") && x.status === "confirmed")) {
    await fetch(`${base}/admin/appointments/${a.id}`, { method: "DELETE", headers: h });
  }
}

const scenarios = [
  { day: "Mittwoch", say: "10 Uhr", hm: "10:00" },
  { day: "Donnerstag", say: "11 Uhr", hm: "11:00" },
  { day: "Freitag", say: "14 Uhr", hm: "14:00" }
];

let ok = 0;
let total = 0;
const failures = [];

for (let round = 0; round < rounds; round++) {
  const sc = scenarios[round % scenarios.length];
  const iso = nextWeekday(sc.day);
  const turns = [
    { say: `Hallo, ich möchte am ${sc.day} um ${sc.say} einen Herrenhaarschnitt buchen. Name: ${NAME}, Telefon: ${PHONE}.`,
      state: (appts) => appts.filter((a) => a.status === "confirmed").length === 0, stateLabel: "noch nicht gebucht" },
    { say: "Ja, bitte buchen.",
      state: (appts) => appts.some((a) => a.status === "confirmed" && a.date === iso && a.time === sc.hm), stateLabel: `gebucht ${iso} ${sc.hm}` },
    { say: `Bitte sagen Sie meinen Termin ab. Meine Telefonnummer ist ${PHONE}.`, state: () => true, stateLabel: "egal" },
    { say: "Ja, bitte absagen.",
      state: (appts) => appts.filter((a) => a.status === "confirmed").length === 0, stateLabel: "abgesagt" },
    { say: "Vielen Dank, das war alles.", state: (appts) => appts.filter((a) => a.status === "confirmed").length === 0, stateLabel: "weiterhin keine offenen Termine" }
  ];

  await cleanup();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/salon-agent/default?name=default`);
  let waiter = null;
  ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "transcript_end" && waiter) waiter(m.text ?? "");
    if (m.type === "error" && waiter) waiter(`[ERROR] ${m.message ?? ""}`);
  });
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

  for (const [i, t] of turns.entries()) {
    total++;
    const started = Date.now();
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("[TIMEOUT]"), 90000);
      waiter = (v) => { clearTimeout(timer); resolve(v); };
      ws.send(JSON.stringify({ type: "text_message", text: t.say }));
    });
    const ms = Date.now() - started;
    await new Promise((r) => setTimeout(r, 700));
    const appts = await listTest();
    const problems = [];
    if (!reply.trim() || reply === "[TIMEOUT]" || reply.startsWith("[ERROR]")) problems.push("leer/Timeout/Fehler");
    if (BAD_SENTENCE.test(reply)) problems.push("Ersatzsatz");
    if (LEAK.test(reply)) problems.push("Technik/JSON sichtbar");
    if (DU.test(reply)) problems.push("Duz-Form");
    if (BROKEN_TIME.test(reply)) problems.push("kaputte Uhrzeit");
    if (/[a-zäöüß][.!?][A-ZÄÖÜ]/.test(reply)) problems.push("fehlendes Leerzeichen");
    if (!t.state(appts)) problems.push(`Zustand erwartet: ${t.stateLabel}`);
    const pass = problems.length === 0;
    if (pass) ok++; else failures.push(`R${round + 1}T${i + 1}: ${problems.join(", ")}`);
    console.log(`[R${round + 1}T${i + 1}] ${pass ? "OK  " : "FAIL"} ${ms}ms ${pass ? "" : "(" + problems.join(", ") + ") "}db=${JSON.stringify(appts.map((a) => `${a.status}@${a.date}T${a.time}`))}\n     ${reply.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  ws.close();
  await cleanup();
}

const left = (await listTest()).filter((a) => a.status === "confirmed").length;
console.log(`ERGEBNIS ${ok}/${total} Zuege erfolgreich; offene Testtermine: ${left}`);
if (failures.length) console.log("FEHLER: " + failures.join(" | "));
process.exit(ok / total >= 0.9 && left === 0 ? 0 : 1);
