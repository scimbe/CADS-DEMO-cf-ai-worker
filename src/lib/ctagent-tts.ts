import type { TTSProvider } from "@cloudflare/voice";

/**
 * TTS über die selbstgehostete Thorsten/Piper-Stimme (LLM2s audio_generation-
 * Channel), erreicht über einen lokalen Bridge-Dienst (~/ct-agent/audio-bridge),
 * da ein Worker/Durable Object das ct-agent-Channel-Protokoll (QUIC, eigener
 * Rust-Prozess) nicht selbst sprechen kann. Der Bridge-Dienst liefert eine
 * HTTPS-URL zur fertigen WAV-Datei zurück, die hier direkt abgerufen wird.
 */
export class CtAgentBridgeTTS implements TTSProvider {
  #bridgeUrl: string;
  #bridgeToken: string;
  #voice: string;

  constructor(options: { bridgeUrl: string; bridgeToken: string; voice?: string }) {
    this.#bridgeUrl = options.bridgeUrl.replace(/\/$/, "");
    this.#bridgeToken = options.bridgeToken;
    this.#voice = options.voice ?? "primary";
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const triggerResponse = await fetch(`${this.#bridgeUrl}/synthesize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#bridgeToken}`
      },
      body: JSON.stringify({ text, voice: this.#voice }),
      signal
    });
    if (!triggerResponse.ok) return null;

    const { url } = (await triggerResponse.json()) as { url?: string };
    if (!url) return null;

    const audioResponse = await fetch(url, { signal });
    if (!audioResponse.ok) return null;
    return await audioResponse.arrayBuffer();
  }
}
