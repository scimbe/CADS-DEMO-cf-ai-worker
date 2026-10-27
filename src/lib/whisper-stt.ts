import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";

/**
 * STT ueber den lokalen stt-service (faster-whisper) per HTTP: POST /transcribe mit WAV als Base64.
 * Der Dienst arbeitet pro Aeusserung (kein Streaming); die Sprechpausen-Erkennung uebernimmt diese
 * Klasse (RMS-Schwelle). Audio kommt als PCM 16 kHz, mono, 16 Bit Little-Endian.
 *
 * Fehlerverhalten (wichtig fuer den Fallback-Wrapper AutoFallbackSTT):
 *  - waitUntilReady() prueft GET /health und lehnt bei Nichterreichbarkeit ab -> Wechsel zum Fallback.
 *  - Scheitert die ERSTE Transkription, wird onFatalError gemeldet (Wechsel moeglich, solange noch
 *    nichts erfolgreich war). Danach werden einzelne Fehler verworfen (Aeusserung geht verloren, der
 *    Anruf laeuft weiter); erst 3 Fehler in Folge sind fatal.
 */
export interface WhisperSTTOptions {
  /** Basis-URL des stt-service, z.B. http://127.0.0.1:8095 */
  baseUrl: string;
  /** Sprachhinweis fuer Whisper (Standard "de"; die Demo ist deutschsprachig). */
  language?: string;
  sampleRate?: number;
  /** RMS-Schwelle (Int16-Skala), ab der Sprache angenommen wird. */
  silenceThresholdRms?: number;
  /** Stille nach Sprache, ab der die Aeusserung als beendet gilt. */
  silenceDurationMs?: number;
  /** Mindestlaenge echter Sprache; kuerzere Geraeusche werden verworfen. */
  minSpeechMs?: number;
  /** Audio vor dem Sprechbeginn, das mitgeschickt wird (Wortanfang nicht abschneiden). */
  prerollMs?: number;
  /** Harte Obergrenze einer Aeusserung. */
  maxUtteranceMs?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ResolvedOptions = Required<Omit<WhisperSTTOptions, "fetchImpl">> & { fetchImpl: typeof fetch };

export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // fmt-Chunk-Groesse
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // Byte-Rate
  v.setUint16(32, 2, true); // Blockgroesse
  v.setUint16(34, 16, true); // Bits pro Sample
  writeStr(36, "data");
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function concat(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class WhisperSTT implements Transcriber {
  #o: ResolvedOptions;

  constructor(opts: WhisperSTTOptions) {
    this.#o = {
      language: "de",
      sampleRate: 16000,
      silenceThresholdRms: 500,
      silenceDurationMs: 700,
      minSpeechMs: 250,
      prerollMs: 300,
      maxUtteranceMs: 30000,
      requestTimeoutMs: 20000,
      healthTimeoutMs: 3000,
      fetchImpl: (...args) => fetch(...args),
      ...opts
    };
  }

  createSession(options: TranscriberSessionOptions = {}): TranscriberSession {
    const o = this.#o;
    const base = o.baseUrl.replace(/\/$/, "");
    const msOf = (s: Int16Array) => (s.length / o.sampleRate) * 1000;

    let closed = false;
    let fatal = false;
    let succeeded = false;
    let failures = 0;

    let speaking = false;
    let speechMs = 0;
    let silenceMs = 0;
    let utteranceMs = 0;
    let utterance: Int16Array[] = [];
    let preroll: Int16Array[] = [];
    let prerollMs = 0;
    let queue: Promise<void> = Promise.resolve();

    const resetUtterance = () => {
      speaking = false;
      speechMs = 0;
      silenceMs = 0;
      utteranceMs = 0;
      utterance = [];
      preroll = [];
      prerollMs = 0;
    };

    const transcribe = async (pcm: Int16Array): Promise<void> => {
      if (closed || fatal) return;
      try {
        const wav = pcm16ToWav(pcm, o.sampleRate);
        const res = await o.fetchImpl(`${base}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio_base64: bytesToBase64(wav), language: o.language, filename: "utterance.wav" }),
          signal: AbortSignal.timeout(o.requestTimeoutMs)
        });
        if (!res.ok) throw new Error(`STT-Dienst antwortete mit HTTP ${res.status}`);
        const data = (await res.json()) as { text?: unknown };
        succeeded = true;
        failures = 0;
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (text && !closed) options.onUtterance?.(text);
      } catch (err) {
        failures++;
        if (closed) return;
        const error = err instanceof Error ? err : new Error(String(err));
        if (!succeeded || failures >= 3) {
          fatal = true;
          options.onFatalError?.(error);
        } else {
          console.warn("[stt] Transkription fehlgeschlagen, Aeusserung verworfen:", error.message);
        }
      }
    };

    const finalize = () => {
      const pcm = concat(utterance);
      resetUtterance();
      queue = queue.then(() => transcribe(pcm));
    };

    let ready: Promise<void> | undefined;
    const checkHealth = async () => {
      const res = await o.fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(o.healthTimeoutMs) });
      if (!res.ok) throw new Error(`STT-Dienst nicht bereit (HTTP ${res.status})`);
    };

    return {
      feed(chunk: ArrayBuffer) {
        if (closed || fatal) return;
        const even = chunk.byteLength - (chunk.byteLength % 2);
        const samples = new Int16Array(chunk.slice(0, even));
        if (samples.length === 0) return;
        const ms = msOf(samples);
        const loud = rms(samples) > o.silenceThresholdRms;

        if (!speaking) {
          if (loud) {
            speaking = true;
            speechMs = ms;
            silenceMs = 0;
            utterance = [...preroll, samples];
            utteranceMs = prerollMs + ms;
            preroll = [];
            prerollMs = 0;
            options.onSpeechStart?.();
          } else {
            preroll.push(samples);
            prerollMs += ms;
            while (prerollMs > o.prerollMs && preroll.length > 1) {
              prerollMs -= msOf(preroll.shift()!);
            }
          }
          return;
        }

        utterance.push(samples);
        utteranceMs += ms;
        if (loud) {
          speechMs += ms;
          silenceMs = 0;
        } else {
          silenceMs += ms;
        }

        if (utteranceMs >= o.maxUtteranceMs) {
          finalize();
        } else if (silenceMs >= o.silenceDurationMs) {
          if (speechMs >= o.minSpeechMs) finalize();
          else resetUtterance(); // kurzes Geraeusch, keine Sprache
        }
      },
      waitUntilReady() {
        ready ??= checkHealth();
        return ready;
      },
      close() {
        closed = true;
        resetUtterance();
      }
    };
  }
}
