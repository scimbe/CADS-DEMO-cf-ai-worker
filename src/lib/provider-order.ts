// Reihenfolge der Sprachmodell-Anbieter. Konfiguriert ueber die (nicht geheime) Variable
// LLM_PROVIDER_ORDER, z.B. "lightllm,workers-ai". Schluessel stehen nie hier, sondern nur in der
// lokalen Env-Datei bzw. .dev.vars.

export type ProviderName = "workers-ai" | "lightllm";

/** Standard: lokales LiteLLM zuerst, Workers AI als Rueckfall (kein Tageskontingent im Normalbetrieb). */
export const DEFAULT_PROVIDER_ORDER: readonly ProviderName[] = ["lightllm", "workers-ai"];

/** Liest "lightllm,workers-ai" (Komma/Leerzeichen); Unbekanntes und Doppeltes entfaellt; leer -> Standard. */
export function parseProviderOrder(raw: string | undefined | null): ProviderName[] {
  const out: ProviderName[] = [];
  for (const part of (raw ?? "").split(/[,\s]+/)) {
    const p = part.trim().toLowerCase();
    if ((p === "workers-ai" || p === "lightllm") && !out.includes(p)) out.push(p);
  }
  return out.length > 0 ? out : [...DEFAULT_PROVIDER_ORDER];
}

/**
 * Die gespeicherte Admin-Einstellung gewinnt: "auto" folgt der konfigurierten Reihenfolge,
 * ein fester Anbieter wird ohne Rueckfall verwendet.
 */
export function resolveProviders(setting: "auto" | ProviderName, order: readonly ProviderName[]): ProviderName[] {
  return setting === "auto" ? [...order] : [setting];
}

export function describeProviderOrder(setting: string, order: readonly ProviderName[]): string {
  return setting === "auto" ? `auto -> ${order.join(" -> ")}` : `fest: ${setting} (ohne Rueckfall)`;
}
