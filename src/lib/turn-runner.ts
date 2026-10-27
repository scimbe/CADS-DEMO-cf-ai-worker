import type { ToolSet } from "ai";
import { extractLeakedToolCalls } from "./leaked-tool-calls";

export const FALLBACK_SENTENCE =
  "Entschuldigung, da habe ich gerade nicht richtig mitgekommen. Könnten Sie das bitte noch einmal sagen?";

export const UNBACKED_SENTENCE =
  "Das konnte ich gerade leider nicht abschließen. Bitte versuchen Sie es noch einmal oder rufen Sie uns direkt an.";

export interface StreamPartLike {
  type: string;
  text?: string;
  error?: unknown;
  toolName?: string;
  output?: unknown;
}

/**
 * Schutz vor erfundenen Erfolgsmeldungen: Behauptet die Antwort eine Aktion
 * (z.B. "gebucht"), muss im selben Zug ein passendes Werkzeug erfolgreich gelaufen sein.
 */
export interface ClaimGuard {
  pattern: RegExp;
  /** Werkzeuge, die die Behauptung belegen koennen. */
  tools: readonly string[];
}

const OK_STATUS = new Set(["gebucht", "abgesagt", "verschoben"]);

function okStatus(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const o = output as { status?: unknown; value?: { status?: unknown } };
  const status = o.status ?? o.value?.status;
  return typeof status === "string" && OK_STATUS.has(status);
}

export interface RunTurnOptions {
  /** Reihenfolge der Anbieter, z.B. ["workers-ai", "lightllm"]. */
  providers: readonly string[];
  /** Startet einen Modellaufruf (inkl. nativer Tool-Schleife) fuer den Anbieter. */
  stream: (provider: string, messages: unknown[]) => AsyncIterable<StreamPartLike>;
  tools: ToolSet;
  messages: unknown[];
  /** Versuche pro Anbieter bei leerer Antwort (Standard 2). */
  triesPerProvider?: number;
  /** Max. Folgeaufrufe nach als Text ausgegebenen Werkzeugaufrufen (Standard 4). */
  maxLeakedRounds?: number;
  /** Pruefungen auf nicht belegte Erfolgsmeldungen. */
  claimGuards?: readonly ClaimGuard[];
  log?: (msg: string, detail?: unknown) => void;
}

interface Attempt {
  text: string;
  error?: unknown;
  nativeToolRan: boolean;
  /** Anzahl je Stream-Part-Typ (Diagnose). */
  counts: Record<string, number>;
  /** Werkzeuge, die in diesem Aufruf erfolgreich gelaufen sind. */
  okTools: string[];
}

async function collect(source: AsyncIterable<StreamPartLike>): Promise<Attempt> {
  let text = "";
  let nativeToolRan = false;
  const counts: Record<string, number> = {};
  const okTools: string[] = [];
  // Workers AI liefert (workers-ai-provider) jedes Text-Delta doppelt. Direkt
  // aufeinanderfolgende identische Deltas werden daher nur einmal uebernommen.
  let lastDelta: string | undefined;
  try {
    for await (const part of source) {
      counts[part.type] = (counts[part.type] ?? 0) + 1;
      if (part.type === "error") return { text, error: part.error ?? part, nativeToolRan, counts, okTools };
      if (part.type === "text-delta" && typeof part.text === "string") {
        if (part.text !== lastDelta) text += part.text;
        lastDelta = part.text;
      } else {
        lastDelta = undefined;
      }
      if (part.type === "tool-result") {
        nativeToolRan = true;
        if (part.toolName && okStatus(part.output)) okTools.push(part.toolName);
      }
    }
  } catch (error) {
    return { text, error, nativeToolRan, counts, okTools };
  }
  return { text, nativeToolRan, counts, okTools };
}

async function executeLeaked(tools: ToolSet, name: string, args: Record<string, unknown>): Promise<unknown> {
  const t = tools[name] as { inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown } }; execute?: (a: unknown, o: unknown) => Promise<unknown> | unknown } | undefined;
  if (!t?.execute) return { status: "unbekanntes_werkzeug" };
  let input: unknown = args;
  const schema = t.inputSchema;
  if (schema && typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { status: "fehler", hinweis: "Ungueltige Parameter, bitte Angaben pruefen und erneut versuchen." };
    input = parsed.data;
  }
  try {
    return await t.execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
  } catch (err) {
    return { status: "fehler", hinweis: err instanceof Error ? err.message : "Werkzeugfehler" };
  }
}

/**
 * Fuehrt einen Gespraechszug robust aus und liefert den bereinigten Antworttext.
 *  - Als JSON-Text ausgegebene Werkzeugaufrufe werden erkannt, ausgefuehrt und nie angezeigt.
 *  - Leere Antworten loesen einen erneuten Versuch aus (nur wenn kein Werkzeug lief).
 *  - Bei Fehlern wird zum naechsten Anbieter gewechselt (nur wenn kein Werkzeug lief).
 *  - Am Ende steht ein freundlicher Ersatzsatz statt Stille oder Fehlermeldung.
 */
export async function runTurnWithRepair(opts: RunTurnOptions): Promise<string> {
  const { providers, stream, tools, log = () => {} } = opts;
  const tries = opts.triesPerProvider ?? 2;
  const maxRounds = opts.maxLeakedRounds ?? 4;
  const toolNames = Object.keys(tools);

  for (const provider of providers) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const messages = [...opts.messages];
      let lastClean = "";
      let toolRan = false;
      let failed = false;
      const okTools = new Set<string>();
      let correctionsLeft = 1;

      for (let round = 0; round <= maxRounds; round++) {
        const res = await collect(stream(provider, messages));
        if (res.nativeToolRan) toolRan = true;
        for (const t of res.okTools) okTools.add(t);
        log(`Anbieter ${provider}: Stream-Teile`, res.counts);
        if (res.error) {
          log(`Anbieter ${provider} lieferte einen Fehler`, res.error);
          failed = true;
          break;
        }
        const { text, calls } = extractLeakedToolCalls(res.text, toolNames);
        if (calls.length === 0) {
          const finalText = text || lastClean;
          if (finalText) {
            const unbacked = (opts.claimGuards ?? []).find(
              (g) => g.pattern.test(finalText) && !g.tools.some((t) => okTools.has(t))
            );
            if (!unbacked) return finalText;
            log(`Anbieter ${provider}: Erfolgsmeldung ohne Werkzeugaufruf`, finalText.slice(0, 120));
            if (correctionsLeft > 0 && round < maxRounds) {
              correctionsLeft--;
              messages.push({ role: "assistant", content: finalText });
              messages.push({
                role: "user",
                content:
                  "[Systemhinweis, nicht vom Gast] Du hast eine Buchung, Absage oder Verschiebung bestaetigt, ohne das passende Werkzeug aufzurufen. Rufe jetzt das passende Werkzeug auf und bestaetige erst nach dessen Ergebnis. Falls du gar nichts ausfuehren wolltest, antworte ohne Erfolgsmeldung."
              });
              continue;
            }
            return UNBACKED_SENTENCE;
          }
          log(`Anbieter ${provider}: leere Antwort (Versuch ${attempt}/${tries})`);
          break;
        }
        // Werkzeugaufrufe wurden als Text ausgegeben: wirklich ausfuehren und weiterfragen.
        toolRan = true;
        if (text) lastClean = text;
        log(`Anbieter ${provider}: ${calls.length} als Text ausgegebene(r) Werkzeugaufruf(e) ausgefuehrt`, calls.map((c) => c.name));
        const toolCalls = calls.map((c) => ({ ...c, id: crypto.randomUUID() }));
        const results: unknown[] = [];
        for (const c of toolCalls) {
          const result = await executeLeaked(tools, c.name, c.args);
          results.push(result);
          if (okStatus(result)) okTools.add(c.name);
        }
        messages.push({
          role: "assistant",
          content: toolCalls.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.args }))
        });
        messages.push({
          role: "tool",
          content: toolCalls.map((c, idx) => ({
            type: "tool-result",
            toolCallId: c.id,
            toolName: c.name,
            output: { type: "json", value: results[idx] }
          }))
        });
      }

      // Hat bereits ein Werkzeug gewirkt (z.B. Buchung), darf nicht erneut versucht
      // und kein anderer Anbieter gefragt werden -- sonst droht doppelte Ausfuehrung.
      if (toolRan) {
        log(`Anbieter ${provider}: Werkzeug lief, aber kein Antworttext -> Ersatzsatz`);
        return FALLBACK_SENTENCE;
      }
      if (failed) break; // direkt zum naechsten Anbieter
    }
  }
  return FALLBACK_SENTENCE;
}
