// Deterministische Wiederherstellung eines Gespraechszugs, wenn das Sprachmodell seinen Vertrag
// bricht (Aktion behauptet statt Werkzeug aufgerufen, leere Antwort, Fehler).
// Ein Extraktionsaufruf liefert nur Rohangaben als JSON; Datum, Zeit, Leistung werden im Code
// gelesen, die Werkzeuge im Code ausgefuehrt und die Antwort aus dem Ergebnis formuliert.
// So kann nie eine Aktion behauptet werden, die nicht stattgefunden hat.
import { SERVICES, type ServiceKey } from "./calendar";
import { longDateDe, parseDatumDe } from "./dates-de";
import { parseUhrzeit } from "./slots";

export interface Extracted {
  aktion?: string | null;
  /** true nur, wenn die LETZTE Gastnachricht die vom Assistenten vorgeschlagene Aktion ausdruecklich bestaetigt. */
  bestaetigt?: boolean | null;
  name?: string | null;
  telefon?: string | null;
  leistung?: string | null;
  datum_text?: string | null;
  uhrzeit_text?: string | null;
  neues_datum_text?: string | null;
  neue_uhrzeit_text?: string | null;
}

type ToolOutput = Record<string, unknown>;

export interface RecoveryDeps {
  extract: () => Promise<Extracted | null>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutput>;
  nowMs: number;
  log?: (msg: string, detail?: unknown) => void;
}

export function normalizeLeistung(input: string | null | undefined): ServiceKey | null {
  if (!input) return null;
  const s = input.toLowerCase();
  if (s in SERVICES) return s as ServiceKey;
  if (/f[aä]e?rb/.test(s)) return "faerben";
  if (/str[aä]e?hn/.test(s)) return "straehnen";
  if (/dauerwelle/.test(s)) return "dauerwelle";
  if (/f[oö]e?hn|styling/.test(s)) return "styling";
  if (/lang/.test(s) && /(schneid|schnitt)/.test(s)) return "schneiden_lang";
  if (/(schneid|schnitt|herren|damen|kurz)/.test(s)) return "schneiden_kurz";
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Formuliert ein Werkzeugergebnis fuer den Gast. Gibt null zurueck, wenn nichts Sinnvolles zu sagen ist. */
export function renderToolOutput(tool: string, output: ToolOutput): string | null {
  const status = str(output.status);
  switch (tool) {
    case "termin_buchen":
      if (status === "gebucht") return `Ihr Termin am ${str(output.bestaetigung)} ist fest gebucht. Wir freuen uns auf Sie!`;
      if (status === "belegt") return "Diese Zeit ist leider schon vergeben. Welche andere Uhrzeit passt Ihnen?";
      if (status === "zu_kurzfristig") return "Das ist zu kurzfristig. Bitte nennen Sie mir eine spätere Zeit.";
      return null;
    case "termin_absagen":
      if (status === "abgesagt") return `Ihr Termin am ${str(output.wann)} wurde abgesagt.`;
      if (status === "mehrere_termine") return "Unter dieser Nummer gibt es mehrere Termine. Welcher soll abgesagt werden?";
      if (status === "nicht_gefunden") return "Unter dieser Nummer habe ich keinen Termin gefunden.";
      return null;
    case "termin_verschieben":
      if (status === "verschoben") return `Ihr Termin wurde auf ${str(output.bestaetigung)} verschoben.`;
      if (status === "belegt") return "Diese Zeit ist leider schon vergeben. Welche andere Uhrzeit passt Ihnen?";
      if (status === "mehrere_termine") return "Unter dieser Nummer gibt es mehrere Termine. Welcher soll verschoben werden?";
      if (status === "nicht_gefunden") return "Unter dieser Nummer habe ich keinen Termin gefunden.";
      return null;
    default:
      return null;
  }
}

function ask(missing: string[]): string {
  const labels: Record<string, string> = {
    name: "Ihren Namen",
    telefon: "Ihre Telefonnummer",
    leistung: "die gewünschte Leistung",
    datum: "das gewünschte Datum",
    uhrzeit: "die gewünschte Uhrzeit",
    neues_datum: "das neue Datum",
    neue_uhrzeit: "die neue Uhrzeit"
  };
  const parts = missing.map((m) => labels[m] ?? m);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} und ${parts[parts.length - 1]}` : parts[0];
  return `Dafür brauche ich noch ${list}.`;
}

export async function recoverTurn(deps: RecoveryDeps): Promise<string | null> {
  const { extract, callTool, nowMs, log = () => {} } = deps;
  const e = await extract();
  if (!e) return null;
  const aktion = (e.aktion ?? "keine").toLowerCase();
  log("Wiederherstellung: Extraktion", JSON.stringify({ ...e, telefon: e.telefon ? "[gesetzt]" : null }));
  if (!["buchen", "absagen", "verschieben", "pruefen"].includes(aktion)) return null;

  const confirmed = e.bestaetigt === true;
  const name = e.name?.trim() || null;
  const telefon = e.telefon?.trim() || null;
  const leistung = normalizeLeistung(e.leistung);
  const datum = parseDatumDe(e.datum_text, nowMs);
  const zeit = parseUhrzeit(e.uhrzeit_text);

  // --- Verfuegbarkeit erfragen oder Buchung vorbereiten ------------------------------------
  if (aktion === "pruefen" || (aktion === "buchen" && !confirmed)) {
    const missing: string[] = [];
    if (!datum) missing.push("datum");
    if (!leistung) missing.push("leistung");
    if (missing.length > 0) return ask(missing);
    const r = await callTool("pruefe_verfuegbarkeit", { datum, leistung, ...(zeit ? { uhrzeit: zeit } : {}) });
    const status = str(r.status);
    if (status === "zu_weit_in_zukunft") return "So weit im Voraus können wir leider noch keine Termine vergeben.";
    if (status === "keine_freien_slots") return `Am ${longDateDe(datum!)} ist leider nichts frei. Möchten Sie einen anderen Tag?`;
    if (status !== "ok") return null;
    const wanted = r.gewuenschte_zeit as { frei?: boolean; antwort_text?: string } | undefined;
    if (zeit && wanted) {
      if (!wanted.frei) return `Am ${longDateDe(datum!)}: ${str(wanted.antwort_text)} Welche Zeit passt Ihnen?`;
      const base = `Am ${longDateDe(datum!)} ist ${zeit} Uhr frei.`;
      if (aktion === "pruefen") return `${base} Möchten Sie den Termin buchen?`;
      const still: string[] = [];
      if (!name) still.push("name");
      if (!telefon) still.push("telefon");
      if (still.length > 0) return `${base} ${ask(still)}`;
      return `${base} Soll ich den Termin für ${name} verbindlich buchen?`;
    }
    return `Am ${longDateDe(datum!)}: ${str(r.antwort_text)} Welche Uhrzeit passt Ihnen?`;
  }

  // --- Verbindlich buchen ------------------------------------------------------------------
  if (aktion === "buchen") {
    const missing: string[] = [];
    if (!name) missing.push("name");
    if (!telefon) missing.push("telefon");
    if (!leistung) missing.push("leistung");
    if (!datum) missing.push("datum");
    if (!zeit) missing.push("uhrzeit");
    if (missing.length > 0) return ask(missing);
    const r = await callTool("termin_buchen", { name, telefon, leistung, datum, uhrzeit: zeit });
    return renderToolOutput("termin_buchen", r);
  }

  // --- Absagen -----------------------------------------------------------------------------
  if (aktion === "absagen") {
    if (!telefon) return ask(["telefon"]);
    if (!confirmed) {
      const r = await callTool("termine_suchen", { telefon });
      if (str(r.status) !== "ok") return "Unter dieser Nummer habe ich keinen Termin gefunden.";
      const termine = (r.termine as Array<{ wann?: string }> | undefined) ?? [];
      if (termine.length === 1) return `Ich habe Ihren Termin am ${str(termine[0].wann)} gefunden. Soll ich ihn absagen?`;
      return `Ich habe mehrere Termine gefunden: ${termine.map((t) => str(t.wann)).join("; ")}. Welcher soll abgesagt werden?`;
    }
    const r = await callTool("termin_absagen", { telefon });
    return renderToolOutput("termin_absagen", r);
  }

  // --- Verschieben -------------------------------------------------------------------------
  const neuesDatum = parseDatumDe(e.neues_datum_text ?? e.datum_text, nowMs);
  const neueZeit = parseUhrzeit(e.neue_uhrzeit_text ?? e.uhrzeit_text);
  const missing: string[] = [];
  if (!telefon) missing.push("telefon");
  if (!neuesDatum) missing.push("neues_datum");
  if (!neueZeit) missing.push("neue_uhrzeit");
  if (missing.length > 0) return ask(missing);
  if (!confirmed) {
    return `Soll ich Ihren Termin auf ${longDateDe(neuesDatum!)} um ${neueZeit} Uhr verschieben?`;
  }
  const r = await callTool("termin_verschieben", { telefon, neues_datum: neuesDatum, neue_uhrzeit: neueZeit });
  return renderToolOutput("termin_verschieben", r);
}

/** Liest das JSON-Objekt aus einer Modellantwort (auch mit Code-Fences oder Begleittext). */
export function parseExtraction(text: string): Extracted | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Extracted) : null;
  } catch {
    return null;
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}

/** Gespraechsverlauf als Klartext ("Gast: ...", "Assistent: ..."), nur die letzten `max` Nachrichten. */
export function transcriptFrom(messages: unknown[], max = 14): string {
  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Gast" : "Assistent"}: ${textOfContent(m.content).replace(/\s+/g, " ").trim()}`)
    .filter((l) => l.length > 10)
    .slice(-max)
    .join("\n");
}

export const EXTRACT_SYSTEM = `Du liest ein Telefongespräch eines Friseursalons und gibst NUR ein JSON-Objekt zurück, ohne Erklärung und ohne Code-Block.
Felder:
- "aktion": "buchen" | "absagen" | "verschieben" | "pruefen" (nur Verfügbarkeit erfragt) | "keine"
- "bestaetigt": true NUR wenn die LETZTE Nachricht des Gastes die vom Assistenten zuvor vorgeschlagene oder erfragte Aktion ausdrücklich bestätigt oder anweist (z.B. "Ja, bitte buchen", "Ja, absagen"). Sonst false.
- "name", "telefon": so wie der Gast sie nannte (Telefon: Ziffern und Leerzeichen), sonst null
- "leistung": "schneiden_kurz" (Herrenhaarschnitt, kurzes Haar), "schneiden_lang", "styling", "faerben", "straehnen", "dauerwelle" oder null
- "datum_text", "uhrzeit_text": genau wie vom Gast genannt (z.B. "Mittwoch", "morgen", "29. Oktober", "10 Uhr"), sonst null
- "neues_datum_text", "neue_uhrzeit_text": nur beim Verschieben, sonst null
Nutze Angaben aus dem gesamten Gespräch, nicht nur aus der letzten Nachricht. Unbekanntes ist null.`;
