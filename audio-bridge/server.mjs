import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PORT = process.env.BRIDGE_PORT || 8090;
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;
const CT_AGENT_BIN = process.env.CT_AGENT_BIN || "/home/becke/ct-agent/ct-agent";

if (!AUTH_TOKEN) {
  console.error("BRIDGE_AUTH_TOKEN muss gesetzt sein");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ein ct-agent-Channel-Verbindungsaufbau (Noise-Handshake + Admission) dauert
// mehrere Sekunden. Statt pro Anfrage neu zu verbinden, wird pro Service EIN
// Prozess dauerhaft offengehalten und über zeilenweises JSON auf
// stdin/stdout wiederverwendet -- deutlich niedrigere Latenz pro Anfrage.
class ChannelClient {
  #serviceName;
  #child = null;
  #rl = null;
  #pendingQueue = [];

  constructor(serviceName) {
    this.#serviceName = serviceName;
  }

  #start() {
    this.#child = spawn(CT_AGENT_BIN, ["channel"], {
      env: { ...process.env, CT_CHANNEL_CALL_SERVICE: this.#serviceName }
    });
    this.#rl = createInterface({ input: this.#child.stdout });
    this.#rl.on("line", (line) => {
      const pending = this.#pendingQueue.shift();
      if (pending) pending.resolve(line);
    });
    this.#child.stderr.on("data", (d) => console.error(`ct-agent channel [${this.#serviceName}]:`, d.toString().trim()));
    this.#child.on("close", (code) => {
      console.error(`ct-agent channel [${this.#serviceName}] beendet (code ${code}), Neustart bei nächster Anfrage`);
      const err = new Error(`ct-agent channel [${this.#serviceName}] exited ${code}`);
      while (this.#pendingQueue.length) this.#pendingQueue.shift().reject(err);
      this.#child = null;
      this.#rl = null;
    });
    this.#child.on("error", (err) => console.error(`ct-agent channel [${this.#serviceName}] Spawn-Fehler:`, err));
  }

  ensureStarted() {
    if (!this.#child) this.#start();
  }

  call(payload) {
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      this.#pendingQueue.push({ resolve, reject });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  // Die Verbindung reconnected zwar selbst nach einem Drop ("early eof"),
  // aber eine Anfrage kann genau in das kurze Reconnect-Fenster fallen.
  // Einmal kurz verzögert wiederholen, statt sofort scheitern zu lassen.
  async callWithRetry(payload) {
    try {
      return await this.call(payload);
    } catch (err) {
      console.error(`[${this.#serviceName}] erster Versuch fehlgeschlagen, retry in 400ms:`, err.message);
      await sleep(400);
      return await this.call(payload);
    }
  }
}

const audioGenClient = new ChannelClient("audio_generation");
const sttClient = new ChannelClient("speech_to_text");

function extractUrl(raw) {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const url = parsed.url || parsed.audio_url || parsed.output || parsed.result;
    if (typeof url === "string") return url;
  } catch {
    // Antwort ist evtl. schon die reine URL, kein JSON -- fällt unten durch.
  }
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  throw new Error(`Unerwartete Antwort vom audio_generation-Channel: ${trimmed.slice(0, 200)}`);
}

function extractTranscript(raw) {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const output = parsed.output ?? parsed.transcript ?? parsed.text ?? parsed.result;
    if (typeof output === "string") {
      if (/^ERROR:/i.test(output)) throw new Error(output);
      return output;
    }
  } catch (err) {
    if (err instanceof Error && /^ERROR:/i.test(err.message)) throw err;
  }
  throw new Error(`Unerwartete Antwort vom speech_to_text-Channel: ${trimmed.slice(0, 200)}`);
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401).end();
    return;
  }

  if (req.method === "POST" && req.url === "/synthesize") {
    let text;
    let voice = "primary";
    try {
      ({ text, voice = "primary" } = await readJsonBody(req));
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }
    if (!text) {
      res.writeHead(400).end("missing text");
      return;
    }
    try {
      const url = extractUrl(await audioGenClient.callWithRetry({ text, voice }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url }));
    } catch (err) {
      console.error("synthesize failed:", err);
      res.writeHead(502).end("synthesis failed");
    }
    return;
  }

  if (req.method === "POST" && req.url === "/transcribe") {
    let audio_url;
    let lang = "de";
    try {
      ({ audio_url, lang = "de" } = await readJsonBody(req));
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }
    if (!audio_url) {
      res.writeHead(400).end("missing audio_url");
      return;
    }
    try {
      const transcript = extractTranscript(await sttClient.callWithRetry({ audio_url, lang }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ transcript }));
    } catch (err) {
      console.error("transcribe failed:", err);
      res.writeHead(502).end(String(err.message || err));
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`audio-bridge listening on 127.0.0.1:${PORT}`);
  audioGenClient.ensureStarted();
  sttClient.ensureStarted();
});
