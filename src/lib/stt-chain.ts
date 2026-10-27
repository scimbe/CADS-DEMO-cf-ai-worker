import type { Transcriber } from "@cloudflare/voice";
import { AutoFallbackSTT } from "./auto-fallback-stt";

/**
 * Verkettet STT-Anbieter in der angegebenen Reihenfolge: Jeder faellt bei einem Fehler VOR der ersten
 * erfolgreichen Nutzung transparent auf den naechsten zurueck (siehe AutoFallbackSTT). Die Anbieter
 * werden erst beim Bedarf erzeugt (lazy), der Fallback also nur, wenn er gebraucht wird.
 */
export function chainTranscribers(factories: ReadonlyArray<() => Transcriber>): Transcriber {
  if (factories.length === 0) throw new Error("Keine STT-Anbieter konfiguriert");
  const [first, ...rest] = factories;
  if (rest.length === 0) return first();
  return new AutoFallbackSTT(first(), () => chainTranscribers(rest));
}
