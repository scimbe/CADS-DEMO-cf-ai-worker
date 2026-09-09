import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";

/**
 * STT über LLM2s speech_to_text-Channel-Service. Anders als Flux (kontinuierliches
 * Streaming mit serverseitiger Turn-Erkennung) ist der Channel-Service reines
 * Request/Response: ein kompletter Audio-Clip als öffentlich abrufbare URL rein,
 * fertiges Transkript raus (kein Streaming, kein Barge-in möglich).
 *
 * Deshalb übernimmt diese Klasse selbst eine einfache energiebasierte
 * Sprechpausen-Erkennung (RMS-Schwellenwert), puffert Audio bis zur erkannten
 * Pause, baut daraus eine WAV-Datei, legt sie kurz über `storeClip` ab (der
 * Worker serviert sie über seine eigene öffentliche Tunnel-URL) und ruft dann
 * den Bridge-Dienst auf.
 */
export interface LightLlmSTTOptions {
  bridgeUrl: string;
  bridgeToken: string;
  /** Öffentliche Basis-URL dieses Agenten, z.B. https://.../agents/salon-agent/default */
  publicBaseUrl: string;
  storeClip: (id: string, wavBytes: ArrayBuffer) => void;
  lang?: string;
  sampleRate?: number;
  silenceThresholdRms?: number;
  silenceDurationMs?: number;
  minUtteranceMs?: number;
}

export class LightLlmSTT implements Transcriber {
  #opts: Required<LightLlmSTTOptions>;

  constructor(opts: LightLlmSTTOptions) {
    this.#opts = {
      lang: "de",
      sampleRate: 16000,
      silenceThresholdRms: 500,
      silenceDurationMs: 700,
      minUtteranceMs: 300,
      ...opts
    };
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const { sampleRate, silenceThresholdRms, silenceDurationMs, minUtteranceMs, lang, bridgeUrl, bridgeToken, publicBaseUrl, storeClip } =
      this.#opts;

    const chunks: ArrayBuffer[] = [];
    let bufferedBytes = 0;
    let hasSpeech = false;
    let silenceMs = 0;
    let closed = false;
    let processing = false;

    const flush = async () => {
      if (closed || processing || bufferedBytes === 0) return;
      const totalMs = (bufferedBytes / 2 / sampleRate) * 1000;
      const collected = chunks.splice(0, chunks.length);
      bufferedBytes = 0;
      hasSpeech = false;
      silenceMs = 0;
      if (totalMs < minUtteranceMs) return;

      processing = true;
      try {
        const wav = pcm16ToWav(concatArrayBuffers(collected), sampleRate);
        const id = crypto.randomUUID();
        storeClip(id, wav);
        const audioUrl = `${publicBaseUrl}/stt-audio/${id}`;

        const res = await fetch(`${bridgeUrl}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
          body: JSON.stringify({ audio_url: audioUrl, lang })
        });
        if (!res.ok) throw new Error(`Bridge-Transcribe fehlgeschlagen: HTTP ${res.status}`);
        const { transcript } = (await res.json()) as { transcript?: string };
        if (transcript?.trim()) options?.onUtterance?.(transcript.trim());
      } catch (err) {
        options?.onFatalError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        processing = false;
      }
    };

    return {
      feed(chunk: ArrayBuffer) {
        if (closed) return;
        chunks.push(chunk);
        bufferedBytes += chunk.byteLength;
        const rms = computeRms(new Int16Array(chunk));
        const chunkMs = (chunk.byteLength / 2 / sampleRate) * 1000;
        if (rms > silenceThresholdRms) {
          hasSpeech = true;
          silenceMs = 0;
        } else if (hasSpeech) {
          silenceMs += chunkMs;
        }
        if (hasSpeech && silenceMs >= silenceDurationMs) {
          void flush();
        }
      },
      close() {
        closed = true;
      }
    };
  }
}

function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function concatArrayBuffers(buffers: ArrayBuffer[]): Uint8Array {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out;
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
}
