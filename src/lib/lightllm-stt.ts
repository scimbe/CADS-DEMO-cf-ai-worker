import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";

/**
 * STT über LLM2s echten Streaming-Channel (speech_to_text_stream): eine
 * WebSocket-Verbindung zur Bridge pro Anruf, die 1:1 auf einen dedizierten,
 * bidirektionalen ct-agent-Channel-Prozess gepiped wird. Wir schicken
 * fortlaufend Audio-Chunks + ein "end" pro erkannter Sprechpause (eigene
 * einfache RMS-basierte Sprechpausen-Erkennung, da der Channel selbst keine
 * Turn-Erkennung übernimmt) und bekommen "partial"/"final"-Transkripte zurück.
 */
export interface LightLlmSTTOptions {
  /** HTTP(S)-Basis-URL der Bridge, z.B. http://127.0.0.1:58090 */
  bridgeUrl: string;
  bridgeToken: string;
  sampleRate?: number;
  silenceThresholdRms?: number;
  silenceDurationMs?: number;
  minUtteranceMs?: number;
}

function toWebSocketUrl(bridgeUrl: string): string {
  // fetch() im Workers-Runtime akzeptiert nur http(s)-URLs (auch für den
  // WebSocket-Upgrade) -- kein ws(s)-Schema, das würfe "Fetch API cannot load".
  return `${bridgeUrl.replace(/\/$/, "")}/stream-stt`;
}

export class LightLlmSTT implements Transcriber {
  #opts: Required<LightLlmSTTOptions>;

  constructor(opts: LightLlmSTTOptions) {
    this.#opts = {
      sampleRate: 16000,
      silenceThresholdRms: 500,
      silenceDurationMs: 700,
      minUtteranceMs: 300,
      ...opts
    };
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    const { sampleRate, silenceThresholdRms, silenceDurationMs, minUtteranceMs, bridgeUrl, bridgeToken } = this.#opts;

    let hasSpeech = false;
    let silenceMs = 0;
    let bufferedMs = 0;
    let closed = false;

    const wsReady = fetch(toWebSocketUrl(bridgeUrl), {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${bridgeToken}` }
    }).then((res) => {
      const ws = res.webSocket;
      if (!ws) throw new Error("Bridge hat kein WebSocket-Upgrade geliefert");
      ws.accept();
      ws.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let msg: { type?: string; text?: string; message?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "partial" && msg.text) options?.onInterim?.(msg.text);
        else if (msg.type === "final" && msg.text) options?.onUtterance?.(msg.text);
        else if (msg.type === "error") options?.onFatalError?.(new Error(msg.message ?? "STT-Stream-Fehler"));
      });
      ws.addEventListener("close", () => {
        if (!closed) options?.onFatalError?.(new Error("STT-Stream-Verbindung unerwartet geschlossen"));
      });
      return ws;
    });

    wsReady.catch((err) => options?.onFatalError?.(err instanceof Error ? err : new Error(String(err))));

    const sendEnd = () => {
      bufferedMs = 0;
      hasSpeech = false;
      silenceMs = 0;
      void wsReady.then((ws) => ws.send(JSON.stringify({ type: "end" }))).catch(() => {});
    };

    return {
      feed(chunk: ArrayBuffer) {
        if (closed) return;
        const rms = computeRms(new Int16Array(chunk));
        const chunkMs = (chunk.byteLength / 2 / sampleRate) * 1000;
        bufferedMs += chunkMs;

        void wsReady
          .then((ws) => {
            const base64 = arrayBufferToBase64(chunk);
            ws.send(JSON.stringify({ type: "audio", data: base64 }));
          })
          .catch(() => {});

        if (rms > silenceThresholdRms) {
          hasSpeech = true;
          silenceMs = 0;
        } else if (hasSpeech) {
          silenceMs += chunkMs;
        }
        if (hasSpeech && silenceMs >= silenceDurationMs && bufferedMs >= minUtteranceMs) {
          sendEnd();
        }
      },
      close() {
        closed = true;
        void wsReady
          .then((ws) => ws.close())
          .catch(() => {});
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
