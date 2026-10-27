// Skriptgesteuerte Testkonversation (Verfuegbarkeit -> buchen -> verschieben -> absagen)
// gegen eine laufende Instanz. Nutzt einen eindeutig markierten Testkunden.
// Aufruf: node scripts/eval-conversation.mjs <port> [label]
// ACHTUNG Kontingent: Jeder Lauf verbraucht Workers-AI-Neurons. Das kostenlose Tageskontingent
// (10.000 Neurons) ist nach wenigen Laeufen aufgebraucht (Fehler 4006); die Produktion faellt
// dann auf LightLLM zurueck. Nicht mehrfach parallel und nicht tagsueber gegen die Demo laufen lassen.
// ACHTUNG: nur gegen eine Instanz mit eigenem --persist-to-Verzeichnis oder gegen
// die Produktion mit anschliessendem Aufraeumen (Termin wird am Ende abgesagt).
import { readFileSync } from "node:fs";

const port = process.argv[2] ?? "8990";
const label = process.argv[3] ?? `port-${port}`;
const base = `http://127.0.0.1:${port}/agents/salon-agent/default`;
const PHONE = "0000 99 88 77";
const NAME = "TEST Evaluation";

const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const adminPassword = /^ADMIN_PASSWORD=(.*)$/m.exec(devVars)?.[1]?.trim();

const turns = [
  { say: "Hallo, welche Termine haben Sie morgen Nachmittag für einen Herrenhaarschnitt frei?", expect: "info" },
  { say: `Ich möchte morgen um 15 Uhr einen Herrenhaarschnitt buchen. Mein Name ist ${NAME}, meine Telefonnummer ist ${PHONE}.`, expect: "any" },
  { say: "Ja, bitte buchen Sie den Termin so.", expect: "booked" },
  { say: `Ich möchte meinen Termin auf übermorgen um 16 Uhr verschieben. Meine Nummer ist ${PHONE}.`, expect: "any" },
  { say: "Ja, bitte verschieben Sie ihn.", expect: "moved" },
  { say: `Ich möchte den Termin doch absagen. Meine Nummer ist ${PHONE}.`, expect: "any" },
  { say: "Ja, bitte sagen Sie den Termin ab.", expect: "cancelled" }
];

const LEAK = /\{\s*"|"parameters"|"type"\s*:\s*"function"|<tool_call>|pruefe_verfuegbarkeit|termin_(buchen|absagen|verschieben)|termine_suchen/;
const FALLBACK = /nicht richtig mitgekommen/;

async function adminList() {
  const login = await fetch(`${base}/admin/login`, { method: "POST", body: JSON.stringify({ password: adminPassword }) });
  const { token } = await login.json();
  const r = await fetch(`${base}/admin/appointments`, { headers: { authorization: `Bearer ${token}` } });
  const data = await r.json();
  const list = Array.isArray(data) ? data : (data.appointments ?? []);
  return list.filter((a) => /TEST/i.test(a.name ?? ""));
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/salon-agent/default?name=default`);
let waiter = null;
ws.addEventListener("message", (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "transcript_end" && m.text !== undefined && waiter) waiter.resolve(m.text);
  if (m.type === "error" && waiter) waiter.resolve(`[ERROR] ${m.message ?? JSON.stringify(m)}`);
});
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

const results = [];
for (const [i, t] of turns.entries()) {
  const started = Date.now();
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("[TIMEOUT]"), 120000);
    waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
    ws.send(JSON.stringify({ type: "text_message", text: t.say }));
  });
  const ms = Date.now() - started;
  await new Promise((r) => setTimeout(r, 800));
  const appts = await adminList();
  const states = appts.map((a) => a.status);
  const row = {
    turn: i + 1, ms,
    leak: LEAK.test(reply), fallback: FALLBACK.test(reply), empty: reply.trim() === "" || reply === "[TIMEOUT]",
    appts: appts.map((a) => `${a.status}@${a.date}T${a.time}`),
    reply: reply.replace(/\s+/g, " ").slice(0, 160)
  };
  results.push({ ...row, expect: t.expect, states });
  console.log(`[${label}] T${row.turn} ${ms}ms leak=${row.leak} fb=${row.fallback} db=${JSON.stringify(row.appts)}\n    ${row.reply}`);
}
ws.close();

const final = results.at(-1).states;
const booked = results[2].states.includes("confirmed");
const moved = results[4].appts.some((s) => s.startsWith("confirmed@") && s.endsWith("T16:00"));
const cancelled = final.length > 0 && final.every((s) => s === "cancelled");
const summary = {
  label,
  leaks: results.filter((r) => r.leak).length,
  fallbacks: results.filter((r) => r.fallback).length,
  empties: results.filter((r) => r.empty).length,
  booked, rescheduled: moved, cancelled,
  medianMs: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)],
  totalMs: results.reduce((a, r) => a + r.ms, 0)
};
console.log("SUMMARY " + JSON.stringify(summary));
process.exit(0);
