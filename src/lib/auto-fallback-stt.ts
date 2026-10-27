import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";

/**
 * Wie beim Text-Fallback (siehe salon-agent.ts streamFromProvider/onTurn):
 * Erst-Fehler des primären Providers vor der ersten echten Aktivität lösen
 * einen transparenten Wechsel zum Fallback-Provider aus. Ein Fehler, der erst
 * NACH bereits erfolgreicher Nutzung auftritt (z.B. WebSocket bricht mitten im
 * Gespräch ab), wird dagegen als echter Fataler Fehler durchgereicht -- ein
 * stiller Anbieterwechsel mitten im laufenden Gespräch wäre riskanter als ein
 * sauberer Abbruch.
 */
export class AutoFallbackSTT implements Transcriber {
  #primary: Transcriber;
  #createFallback: () => Transcriber;

  constructor(primary: Transcriber, createFallback: () => Transcriber) {
    this.#primary = primary;
    this.#createFallback = createFallback;
  }

  createSession(options: TranscriberSessionOptions = {}): TranscriberSession {
    let usingFallback = false;
    let settled = false;
    let closed = false;
    let pendingChunks: ArrayBuffer[] = [];
    let activeSession: TranscriberSession;

    // Idempotent: sowohl der onFatalError-Callback (feuert bei manchen
    // Providern VOR der Ablehnung von waitUntilReady, siehe FluxSession) als
    // auch der waitUntilReady-catch unten können hierher gelangen -- nur der
    // erste Aufruf wechselt tatsächlich den Provider.
    const switchToFallback = (error: Error): TranscriberSession => {
      if (usingFallback) return activeSession;
      usingFallback = true;
      console.error("STT-Primäranbieter fehlgeschlagen, wechsle auf Fallback:", error.message);
      activeSession = this.#createFallback().createSession(options);
      for (const chunk of pendingChunks) activeSession.feed(chunk);
      pendingChunks = [];
      return activeSession;
    };

    const wrappedOptions: TranscriberSessionOptions = {
      ...options,
      onInterim: (text) => {
        settled = true;
        pendingChunks = [];
        options.onInterim?.(text);
      },
      onSpeechStart: (text) => {
        settled = true;
        pendingChunks = [];
        options.onSpeechStart?.(text);
      },
      onUtterance: (text) => {
        settled = true;
        pendingChunks = [];
        options.onUtterance?.(text);
      },
      onFatalError: (error) => {
        if (settled || usingFallback || closed) {
          options.onFatalError?.(error);
          return;
        }
        switchToFallback(error);
      }
    };

    activeSession = this.#primary.createSession(wrappedOptions);

    return {
      feed(chunk: ArrayBuffer) {
        if (closed) return;
        activeSession.feed(chunk);
        if (!usingFallback && !settled) pendingChunks.push(chunk);
      },
      // Die Pipeline wartet selbst auf waitUntilReady() und bricht bei
      // Ablehnung sofort ab -- der Fallback-Wechsel muss deshalb HIER
      // (nicht nur im onFatalError-Callback) abgeschlossen sein, sonst sieht
      // die Pipeline die Ablehnung des primären Providers, bevor der Wechsel
      // überhaupt greifen kann.
      waitUntilReady: async () => {
        try {
          await activeSession.waitUntilReady?.();
        } catch (err) {
          if (settled || closed) throw err;
          const fallbackSession = switchToFallback(err instanceof Error ? err : new Error(String(err)));
          await fallbackSession.waitUntilReady?.();
        }
      },
      updateAgentContext: (text: string) => activeSession.updateAgentContext?.(text),
      close() {
        closed = true;
        pendingChunks = [];
        activeSession.close();
      }
    };
  }
}
