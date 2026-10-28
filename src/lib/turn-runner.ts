import type { ToolSet } from "ai";
import { extractLeakedToolCalls } from "./leaked-tool-calls";
import { extractTimes, splitSentences, stripToolNarration } from "./text-guards";

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
 * Schutz vor Behauptungen ohne Beleg im selben Zug.
 *  - "action" (Standard): Erfolgsmeldung ("gebucht") nur, wenn eines der `tools` erfolgreich lief.
 *  - "unavailable": "vergeben/nicht frei" nur, wenn ein Werkzeug genau diese Uhrzeit als nicht frei
 *    meldete (oder den ganzen Tag als nicht buchbar). Nennt der Satz keine Uhrzeit, genuegt irgendeine
 *    Nicht-frei-Meldung.
 *  - "checked": Aussage nur, wenn eines der `tools` in diesem Zug ueberhaupt ein Ergebnis lieferte
 *    (z.B. "14:00 ist frei" nur nach einer Verfuegbarkeitspruefung, nicht aus dem Gespraechsverlauf).
 *  - "style": Stilregel (z.B. Anrede "Sie"); ein Korrekturversuch, danach wird der Text trotzdem geliefert.
 */
export type GuardMode = "action" | "unavailable" | "checked" | "style";

export type ToolChoiceOption = "required" | { type: "tool"; toolName: string };

export interface StreamOptions {
  /** Erzwingt im ERSTEN Schritt dieses Aufrufs einen Werkzeugaufruf (nur bei Korrekturversuchen). */
  toolChoice?: ToolChoiceOption;
}

export interface ClaimGuard {
  mode?: GuardMode;
  /** Werkzeug, das ein Korrekturversuch erzwingen soll (Standard: das einzige Werkzeug in `tools`). */
  forceTool?: string;
  pattern: RegExp;
  /** Treffer dieses Musters im Text entkraeften die Pruefung (z.B. Absage-Wortlaut bei Buchungs-Guard). */
  unless?: RegExp;
  /** Nur fuer "action": Werkzeuge, die die Behauptung belegen koennen. */
  tools?: readonly string[];
  /** Korrekturhinweis an das Modell (nicht an den Gast). */
  hint?: string;
}

const OK_STATUS = new Set(["gebucht", "abgesagt", "verschoben"]);
const DAY_UNAVAILABLE_STATUS = new Set(["keine_freien_slots", "zu_weit_in_zukunft", "zu_kurzfristig", "belegt"]);

interface Evidence {
  okTools: Set<string>;
  /** Uhrzeiten (HH:MM), die ein Werkzeug als nicht frei gemeldet hat. */
  unavailableTimes: Set<string>;
  /** Ein Werkzeug hat den Tag/Termin insgesamt als nicht buchbar gemeldet. */
  dayUnavailable: boolean;
  /** Ein Werkzeug wurde wegen verwechselter Aktion abgelehnt (Gast wollte etwas anderes). */
  refused: boolean;
  /** Alle Werkzeugergebnisse dieses Zuges (zum Wiedergeben, falls das Modell keinen Text liefert). */
  results: Array<{ tool: string; output: Record<string, unknown> }>;
}

function newEvidence(): Evidence {
  return { okTools: new Set(), unavailableTimes: new Set(), dayUnavailable: false, refused: false, results: [] };
}

function unwrap(output: unknown): Record<string, unknown> | null {
  if (typeof output !== "object" || output === null) return null;
  const o = output as Record<string, unknown>;
  if (o.type === "json" && typeof o.value === "object" && o.value !== null) return o.value as Record<string, unknown>;
  return o;
}

function recordEvidence(ev: Evidence, toolName: string | undefined, output: unknown): void {
  const o = unwrap(output);
  if (!o) return;
  if (toolName) ev.results.push({ tool: toolName, output: o });
  const status = typeof o.status === "string" ? o.status : undefined;
  if (status && OK_STATUS.has(status) && toolName) ev.okTools.add(toolName);
  if (status === "abgelehnt") ev.refused = true;
  if (status && DAY_UNAVAILABLE_STATUS.has(status)) ev.dayUnavailable = true;
  const wanted = o.gewuenschte_zeit as { zeit?: unknown; frei?: unknown } | undefined;
  if (wanted && wanted.frei === false && typeof wanted.zeit === "string") ev.unavailableTimes.add(wanted.zeit);
}

function violated(g: ClaimGuard, text: string, ev: Evidence): boolean {
  if (!g.pattern.test(text)) return false;
  if (g.unless?.test(text)) return false;
  switch (g.mode ?? "action") {
    case "style":
      return true;
    case "action":
      return !(g.tools ?? []).some((t) => ev.okTools.has(t));
    case "checked":
      return !ev.results.some((r) => (g.tools ?? []).includes(r.tool));
    case "unavailable": {
      if (ev.dayUnavailable) return false;
      for (const sentence of splitSentences(text).filter((s) => g.pattern.test(s))) {
        const times = extractTimes(sentence);
        if (times.size === 0) {
          if (ev.unavailableTimes.size === 0) return true;
        } else {
          for (const t of times) if (!ev.unavailableTimes.has(t)) return true;
        }
      }
      return false;
    }
  }
}

function pickToolChoice(broken: readonly ClaimGuard[], knownTools: readonly string[]): ToolChoiceOption | undefined {
  const wanted = new Set<string>();
  for (const g of broken) {
    if (g.mode === "style") continue;
    if (g.forceTool) wanted.add(g.forceTool);
    else for (const t of g.tools ?? []) wanted.add(t);
  }
  const usable = [...wanted].filter((t) => knownTools.includes(t));
  // Das LiteLLM-Backend ignoriert eine benannte Werkzeugwahl (-> ToolChoiceViolationError), "required" geht.
  return usable.length > 0 ? "required" : undefined;
}

const DEFAULT_HINT =
  "[Systemhinweis, nicht vom Gast] Du hast eine Buchung, Absage oder Verschiebung bestaetigt, ohne das passende Werkzeug aufzurufen. Rufe jetzt das passende Werkzeug auf und bestaetige erst nach dessen Ergebnis. Falls du gar nichts ausfuehren wolltest, antworte ohne Erfolgsmeldung.";

export interface RunTurnOptions {
  /** Reihenfolge der Anbieter, z.B. ["workers-ai", "lightllm"]. */
  providers: readonly string[];
  /** Startet einen Modellaufruf (inkl. nativer Tool-Schleife) fuer den Anbieter. */
  stream: (provider: string, messages: unknown[], options?: StreamOptions) => AsyncIterable<StreamPartLike>;
  tools: ToolSet;
  messages: unknown[];
  /** Versuche pro Anbieter bei leerer Antwort (Standard 2). */
  triesPerProvider?: number;
  /** Max. Folgeaufrufe nach als Text ausgegebenen Werkzeugaufrufen (Standard 4). */
  maxLeakedRounds?: number;
  /**
   * Anbieter, deren Stream jedes Text-Delta doppelt liefert (Workers AI). Nur dort wird entdoppelt;
   * bei anderen Anbietern wuerde das legitime Wiederholungen ("00" in "09:00") zerstoeren.
   */
  doubledDeltaProviders?: readonly string[];
  /**
   * Letzte Rettung, wenn das Modell seinen Vertrag bricht (Behauptung ohne Beleg, leer, Fehler):
   * liefert eine deterministisch erzeugte Antwort oder null.
   */
  recover?: () => Promise<string | null>;
  /** Formuliert ein Werkzeugergebnis (fuer Zuege, in denen das Modell nach einer Aktion keinen Text liefert). */
  renderResult?: (tool: string, output: Record<string, unknown>) => string | null;
  /** Pruefungen auf nicht belegte Behauptungen und Stilregeln. */
  claimGuards?: readonly ClaimGuard[];
  log?: (msg: string, detail?: unknown) => void;
}

interface Attempt {
  text: string;
  error?: unknown;
  nativeToolRan: boolean;
  /** Anzahl je Stream-Part-Typ (Diagnose). */
  counts: Record<string, number>;
}

async function collect(source: AsyncIterable<StreamPartLike>, doubled: boolean, ev: Evidence): Promise<Attempt> {
  let text = "";
  let nativeToolRan = false;
  const counts: Record<string, number> = {};
  // Laufweise Entdopplung: Liefert der Anbieter jedes Delta doppelt, besteht ein Lauf aus n
  // identischen Deltas fuer n/2 echte (auch eine echte Wiederholung "0","0" kommt dann als 4x "0").
  let runDelta: string | undefined;
  let runCount = 0;
  const flushRun = () => {
    if (runDelta !== undefined) text += runDelta.repeat(doubled ? Math.ceil(runCount / 2) : runCount);
    runDelta = undefined;
    runCount = 0;
  };
  try {
    for await (const part of source) {
      counts[part.type] = (counts[part.type] ?? 0) + 1;
      if (part.type === "text-start") {
        // Neues Textsegment (z.B. nach einem Werkzeugschritt): nie nahtlos an den vorigen Satz kleben.
        flushRun();
        if (text && !/\s$/.test(text)) text += " ";
      }
      if (part.type === "error") {
        flushRun();
        return { text, error: part.error ?? part, nativeToolRan, counts };
      }
      if (part.type === "text-delta" && typeof part.text === "string") {
        if (part.text === runDelta) runCount++;
        else {
          flushRun();
          runDelta = part.text;
          runCount = 1;
        }
      } else {
        flushRun();
      }
      if (part.type === "tool-result") {
        nativeToolRan = true;
        recordEvidence(ev, part.toolName, part.output);
      }
    }
  } catch (error) {
    flushRun();
    return { text, error, nativeToolRan, counts };
  }
  flushRun();
  return { text, nativeToolRan, counts };
}

export async function executeLeaked(tools: ToolSet, name: string, args: Record<string, unknown>): Promise<unknown> {
  const t = tools[name] as
    | {
        inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown } };
        execute?: (a: unknown, o: unknown) => Promise<unknown> | unknown;
      }
    | undefined;
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
 *  - Saetze, die Werkzeuge/Technik erwaehnen, werden entfernt.
 *  - Leere Antworten loesen einen erneuten Versuch aus (nur wenn kein Werkzeug lief).
 *  - Bei Fehlern wird zum naechsten Anbieter gewechselt (nur wenn kein Werkzeug lief).
 *  - Behauptungen (gebucht / vergeben) brauchen einen Beleg im selben Zug; Stilregeln (Anrede) werden
 *    mit einem Korrekturversuch durchgesetzt.
 *  - Am Ende steht ein freundlicher Ersatzsatz statt Stille oder Fehlermeldung.
 */
export async function runTurnWithRepair(opts: RunTurnOptions): Promise<string> {
  const { providers, stream, tools, log = () => {} } = opts;
  const tries = opts.triesPerProvider ?? 2;
  const maxRounds = opts.maxLeakedRounds ?? 4;
  const toolNames = Object.keys(tools);
  const guards = opts.claimGuards ?? [];

  // Aufgeben ist der letzte Schritt: Hat ein Werkzeug schon etwas bewirkt, wird dessen Ergebnis
  // wiedergegeben (nie erneut ausgefuehrt). Sonst versucht die deterministische Wiederherstellung.
  const giveUp = async (fallback: string, ev: Evidence): Promise<string> => {
    if (ev.okTools.size > 0) {
      for (const r of [...ev.results].reverse()) {
        const rendered = opts.renderResult?.(r.tool, r.output);
        if (rendered) return rendered;
      }
      return fallback;
    }
    if (opts.recover) {
      try {
        const recovered = await opts.recover();
        if (recovered) return recovered;
      } catch (err) {
        log("Wiederherstellung fehlgeschlagen", err);
      }
    }
    return fallback;
  };

  for (const provider of providers) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      const messages = [...opts.messages];
      const ev = newEvidence();
      let lastClean = "";
      let toolRan = false;
      let failed = false;
      let correctionsLeft = 1;
      let nextChoice: ToolChoiceOption | undefined;
      // Aktionen, die das Modell behauptet hat und die nach dem Korrekturversuch belegt sein MUESSEN.
      let owed: ClaimGuard[] = [];

      for (let round = 0; round <= maxRounds; round++) {
        const res = await collect(
          stream(provider, messages, nextChoice ? { toolChoice: nextChoice } : undefined),
          (opts.doubledDeltaProviders ?? []).includes(provider),
          ev
        );
        const forcedThisRound = nextChoice !== undefined;
        nextChoice = undefined;
        if (res.nativeToolRan) toolRan = true;
        log(`Anbieter ${provider}: Stream-Teile`, res.counts);
        if (res.error) {
          log(`Anbieter ${provider} lieferte einen Fehler`, res.error);
          // Ignoriert das Modell einen erzwungenen Werkzeugaufruf, ist das kein Ausfall des Anbieters:
          // kein Anbieterwechsel (verbraucht Kontingent, bringt nichts), sondern direkt die Wiederherstellung.
          if (forcedThisRound) return await giveUp(FALLBACK_SENTENCE, ev);
          failed = true;
          break;
        }
        // Das Modell hat die Aktion verwechselt (Werkzeug abgelehnt) und nichts Passendes bewirkt: sofort retten.
        if (ev.refused && ev.okTools.size === 0) {
          log(`Anbieter ${provider}: Aktion verwechselt (abgelehnt) -> Wiederherstellung`);
          return await giveUp(FALLBACK_SENTENCE, ev);
        }
        const extracted = extractLeakedToolCalls(res.text, toolNames);
        const text = stripToolNarration(extracted.text);
        const calls = extracted.calls;
        if (calls.length === 0) {
          const finalText = text || lastClean;
          if (finalText) {
            const broken = guards.filter((g) => violated(g, finalText, ev));
            if (broken.length === 0) {
              // Der Korrekturversuch darf nicht mit einem harmlos klingenden Text enden, ohne dass die
              // behauptete Aktion wirklich stattfand (z.B. "required" waehlte nur die Verfuegbarkeitspruefung).
              const unmet = owed.some((g) => !(g.tools ?? []).some((t) => ev.okTools.has(t)));
              if (unmet) {
                log(`Anbieter ${provider}: behauptete Aktion nach Korrektur weiterhin nicht belegt -> Wiederherstellung`);
                return await giveUp(UNBACKED_SENTENCE, ev);
              }
              return finalText;
            }
            log(`Anbieter ${provider}: Behauptung/Stil ohne Beleg`, finalText.slice(0, 120));
            if (correctionsLeft > 0 && round < maxRounds) {
              correctionsLeft--;
              nextChoice = pickToolChoice(broken, toolNames);
              owed = broken.filter((g) => (g.mode ?? "action") === "action");
              messages.push({ role: "assistant", content: finalText });
              messages.push({
                role: "user",
                content: broken.map((g) => g.hint ?? DEFAULT_HINT).join(" ")
              });
              continue;
            }
            // Stilverstoss allein ist kein Grund, die Antwort zu verwerfen.
            if (broken.every((g) => g.mode === "style")) return finalText;
            return await giveUp(UNBACKED_SENTENCE, ev);
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
          recordEvidence(ev, c.name, result);
        }
        if (ev.refused && ev.okTools.size === 0) {
          log(`Anbieter ${provider}: Aktion verwechselt (abgelehnt) -> Wiederherstellung`);
          return await giveUp(FALLBACK_SENTENCE, ev);
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
        log(`Anbieter ${provider}: Werkzeug lief, aber kein Antworttext`);
        return await giveUp(FALLBACK_SENTENCE, ev);
      }
      if (failed) break; // direkt zum naechsten Anbieter
    }
  }
  return await giveUp(FALLBACK_SENTENCE, newEvidence());
}
