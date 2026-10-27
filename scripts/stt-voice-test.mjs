// Simulierter Sprachanruf ohne Mikrofon: spielt eine 16-kHz-Mono-16-Bit-WAV-Datei ueber den
// Voice-WebSocket der laufenden Instanz ab (start_call, rohe PCM-Frames, danach Stille) und gibt
// das erkannte Transkript der Gast-Aeusserung aus. Prueft die komplette STT-Kette im Worker.
// Aufruf: node scripts/stt-voice-test.mjs <wav-datei> [port=8990]
import { readFileSync } from "node:fs";

const wavPath = process.argv[2];
const port = process.argv[3] ?? "8990";
if (!wavPath) {
  console.error("Aufruf: node scripts/stt-voice-test.mjs <wav-datei> [port]");
  process.exit(2);
}

function readPcm16(path) {
  const buf = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      const bytes = buf.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("kein data-Chunk in der WAV-Datei");
}

const pcm = readPcm16(wavPath);
const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/salon-agent/default?name=default`);
const seen = [];
let userTranscript = null;

ws.addEventListener("message", (ev) => {
  if (typeof ev.data !== "string") return; // Audio der Antwort (TTS) ignorieren
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  seen.push(m.type);
  if (m.type === "transcript" && m.role === "user" && userTranscript === null) userTranscript = m.text;
  if (m.type === "error") console.log("FEHLERMELDUNG:", m.message ?? JSON.stringify(m));
});

await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
ws.send(JSON.stringify({ type: "start_call" }));
await new Promise((r) => setTimeout(r, 2500)); // Begruessung/Aufbau abwarten

const CHUNK = 320; // 20 ms
const send = async (samples) => {
  for (let i = 0; i < samples.length; i += CHUNK) {
    ws.send(samples.slice(i, i + CHUNK).buffer);
    await new Promise((r) => setTimeout(r, 10)); // schneller als Echtzeit
  }
};
await send(new Int16Array(8000)); // 0,5 s Stille
await send(pcm);
await send(new Int16Array(24000)); // 1,5 s Stille -> Ende der Aeusserung

const deadline = Date.now() + 30000;
while (userTranscript === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

ws.send(JSON.stringify({ type: "end_call" }));
await new Promise((r) => setTimeout(r, 500));
ws.close();

console.log("Nachrichtentypen:", [...new Set(seen)].join(", "));
console.log("TRANSKRIPT:", userTranscript ?? "(keines)");
process.exit(userTranscript ? 0 : 1);
