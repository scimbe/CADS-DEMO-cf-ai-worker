import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WhisperSTT } from "../src/lib/whisper-stt";

// Integrationstest gegen den ECHTEN lokalen stt-service. Laeuft nur, wenn STT_LIVE_WAV auf eine
// 16-kHz-Mono-16-Bit-WAV-Datei zeigt, z.B.:
//   STT_LIVE_WAV=/tmp/stt-test.wav STT_WHISPER_URL=http://127.0.0.1:8095 npx vitest run tests/stt-live.test.ts
const wavPath = process.env.STT_LIVE_WAV;
const baseUrl = process.env.STT_WHISPER_URL ?? "http://127.0.0.1:8095";

function readPcm16(path: string): Int16Array {
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
  throw new Error("kein data-Chunk");
}

describe.skipIf(!wavPath)("WhisperSTT gegen den echten stt-service", () => {
  it("transkribiert einen deutschen Satz ueber denselben Codepfad wie im Anruf", async () => {
    const pcm = readPcm16(wavPath!);
    const utterances: string[] = [];
    let fatal: Error | undefined;
    const session = new WhisperSTT({ baseUrl }).createSession({
      onUtterance: (t) => utterances.push(t),
      onFatalError: (e) => (fatal = e)
    });
    await session.waitUntilReady!(); // /health

    const CHUNK = 320;
    const feed = (p: Int16Array) => {
      for (let i = 0; i < p.length; i += CHUNK) session.feed(p.slice(i, i + CHUNK).buffer as ArrayBuffer);
    };
    feed(new Int16Array(8000)); // 0,5 s Stille davor
    feed(pcm);
    feed(new Int16Array(16000)); // 1 s Stille danach -> Aeusserung beendet

    const deadline = Date.now() + 30000;
    while (utterances.length === 0 && !fatal && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

    expect(fatal).toBeUndefined();
    expect(utterances).toHaveLength(1);
    console.log("TRANSKRIPT:", utterances[0]);
    const text = utterances[0].toLowerCase();
    expect(text).toMatch(/freitag/);
    expect(text).toMatch(/termin/);
    expect(text).toMatch(/(10|zehn)/);
  }, 40000);
});
