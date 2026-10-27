import { describe, expect, it, vi } from "vitest";
import { WhisperSTT, bytesToBase64, pcm16ToWav } from "../src/lib/whisper-stt";

const SR = 16000;
const CHUNK = 320; // 20 ms

function tone(ms: number, amp = 6000): Int16Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SR) * amp);
  return out;
}
const silence = (ms: number) => new Int16Array(Math.round((SR * ms) / 1000));

function feedAll(session: { feed(c: ArrayBuffer): void }, pcm: Int16Array) {
  for (let i = 0; i < pcm.length; i += CHUNK) {
    session.feed(pcm.slice(i, i + CHUNK).buffer as ArrayBuffer);
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wavFromBody(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body));
  const bytes = Uint8Array.from(atob(body.audio_base64), (c) => c.charCodeAt(0));
  return { body, bytes, view: new DataView(bytes.buffer) };
}

describe("pcm16ToWav / bytesToBase64", () => {
  it("schreibt einen gueltigen WAV-Header (16 kHz, mono, 16 Bit)", () => {
    const wav = pcm16ToWav(new Int16Array([1, -1, 2, -2]), 16000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(44, true)).toBe(1);
    expect(v.getInt16(46, true)).toBe(-1);
    expect(wav.length).toBe(44 + 8);
  });

  it("kodiert grosse Puffer ohne Stack-Ueberlauf", () => {
    const big = new Uint8Array(500_000).fill(65);
    expect(atob(bytesToBase64(big)).length).toBe(500_000);
  });
});

describe("WhisperSTT", () => {
  function setup(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    }) as unknown as typeof fetch;
    const events = { utterances: [] as string[], speechStarts: 0, fatal: [] as Error[] };
    const session = new WhisperSTT({ baseUrl: "http://stt.test:8095/", fetchImpl }).createSession({
      onUtterance: (t) => events.utterances.push(t),
      onSpeechStart: () => events.speechStarts++,
      onFatalError: (e) => events.fatal.push(e)
    });
    return { session, calls, events, fetchImpl };
  }

  it("erkennt Sprache + Sprechpause, schickt WAV an /transcribe und meldet die Aeusserung", async () => {
    const { session, calls, events } = setup(() => jsonResponse({ text: " Ich moechte am Freitag um zehn Uhr einen Termin. ", language: "de" }));
    feedAll(session, silence(200));
    feedAll(session, tone(1000));
    feedAll(session, silence(900));
    await flush();
    await flush();

    expect(events.speechStarts).toBe(1);
    expect(events.utterances).toEqual(["Ich moechte am Freitag um zehn Uhr einen Termin."]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://stt.test:8095/transcribe");
    const { body, bytes, view } = wavFromBody(calls[0].init);
    expect(body.language).toBe("de");
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    // Preroll (<= 300 ms) + 1 s Sprache + 700 ms Stille bis zur Erkennung
    const samples = (bytes.length - 44) / 2;
    expect(samples).toBeGreaterThan(SR * 1.6);
    expect(samples).toBeLessThan(SR * 2.3);
  });

  it("schickt nichts bei reiner Stille oder sehr kurzen Geraeuschen", async () => {
    const { session, calls, events } = setup(() => jsonResponse({ text: "x" }));
    feedAll(session, silence(2000));
    feedAll(session, tone(60)); // zu kurz
    feedAll(session, silence(1000));
    await flush();
    expect(calls).toHaveLength(0);
    expect(events.utterances).toEqual([]);
  });

  it("ignoriert leere Transkripte", async () => {
    const { session, events } = setup(() => jsonResponse({ text: "   " }));
    feedAll(session, tone(800));
    feedAll(session, silence(900));
    await flush();
    await flush();
    expect(events.utterances).toEqual([]);
    expect(events.fatal).toEqual([]);
  });

  it("meldet nacheinander mehrere Aeusserungen in der richtigen Reihenfolge", async () => {
    let n = 0;
    const { session, events } = setup(() => jsonResponse({ text: `Satz ${++n}` }));
    feedAll(session, tone(600));
    feedAll(session, silence(900));
    feedAll(session, tone(600));
    feedAll(session, silence(900));
    await flush();
    await flush();
    await flush();
    expect(events.utterances).toEqual(["Satz 1", "Satz 2"]);
    expect(events.speechStarts).toBe(2);
  });

  it("begrenzt sehr lange Aeusserungen hart", async () => {
    const { session, calls } = setup(() => jsonResponse({ text: "lang" }));
    feedAll(session, tone(32000)); // laenger als maxUtteranceMs (30 s)
    await flush();
    await flush();
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("meldet Fehler der ERSTEN Transkription als fatal (Fallback moeglich)", async () => {
    const { session, events } = setup(() => jsonResponse({ error: "x" }, 503));
    feedAll(session, tone(600));
    feedAll(session, silence(900));
    await flush();
    await flush();
    expect(events.fatal).toHaveLength(1);
    expect(events.fatal[0].message).toContain("503");
  });

  it("verwirft einzelne spaetere Fehler, meldet aber 3 in Folge als fatal", async () => {
    let ok = true;
    const { session, events } = setup(() => (ok ? jsonResponse({ text: "gut" }) : jsonResponse({}, 500)));
    const utter = async () => {
      feedAll(session, tone(600));
      feedAll(session, silence(900));
      await flush();
      await flush();
    };
    await utter(); // Erfolg
    ok = false;
    await utter(); // 1. Fehler: verworfen
    await utter(); // 2. Fehler: verworfen
    expect(events.fatal).toHaveLength(0);
    await utter(); // 3. Fehler: fatal
    expect(events.fatal).toHaveLength(1);
    expect(events.utterances).toEqual(["gut"]);
  });

  it("waitUntilReady prueft /health und lehnt bei Nichterreichbarkeit ab", async () => {
    const up = setup((url) => (url.endsWith("/health") ? jsonResponse({ status: "ok" }) : jsonResponse({})));
    await expect(up.session.waitUntilReady!()).resolves.toBeUndefined();
    expect(up.calls[0].url).toBe("http://stt.test:8095/health");

    const down = setup(() => jsonResponse({ status: "error" }, 503));
    await expect(down.session.waitUntilReady!()).rejects.toThrow("503");

    const refused = setup(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(refused.session.waitUntilReady!()).rejects.toThrow("ECONNREFUSED");
  });

  it("liefert nach close() nichts mehr", async () => {
    const { session, calls, events } = setup(() => jsonResponse({ text: "zu spaet" }));
    feedAll(session, tone(600));
    session.close();
    feedAll(session, silence(900));
    await flush();
    expect(calls).toHaveLength(0);
    expect(events.utterances).toEqual([]);
  });

  it("verkraftet ungerade Chunk-Laengen", () => {
    const { session } = setup(() => jsonResponse({ text: "" }));
    expect(() => session.feed(new ArrayBuffer(321))).not.toThrow();
    expect(() => session.feed(new ArrayBuffer(0))).not.toThrow();
  });
});
