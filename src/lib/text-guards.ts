// Deterministische Textpruefungen fuer Antworten des Terminassistenten.

const TOOL_NAMES =
  "pruefe_verfuegbarkeit|termin_buchen|termin_absagen|termin_verschieben|termine_suchen|termin_id";

// Saetze, die Technik erwaehnen ("Ich rufe jetzt das Werkzeug zur Terminabsage auf"), duerfen den
// Gast nie erreichen.
const NARRATION = new RegExp(
  [
    `\\b(?:werkzeug\\w*|tools?|funktionsaufruf\\w*|funktion|datenbank\\w*|api|systemhinweis)\\b`,
    `\\b(?:${TOOL_NAMES})\\b`,
    `\\bich\\s+(?:rufe|starte|führe|fuehre|nutze|verwende|benutze)\\b[^.!?]*\\b(?:auf|aus)\\b`
  ].join("|"),
  "i"
);

// Satzende nach Buchstabe+Punkt oder ! ?; nach Ziffer+Punkt nur, wenn kein Monatsname folgt
// ("29. Oktober" bleibt zusammen, "lautet 12. Danke." wird getrennt).
const MONTH_AWARE_SPLIT = new RegExp(
  "(?<=[^\\d.\\s][.]|[!?])\\s+|(?<=\\d[.])\\s+(?!(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\\b)(?=[A-ZÄÖÜ])"
);

/**
 * Teilt in Saetze. Punkte nach Ziffern ("29. Oktober") und Uhrzeiten ("10.30") trennen nicht.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(MONTH_AWARE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Entfernt Saetze mit Werkzeug-/Technik-Erzaehlung und eingebettete [Systemhinweis ...]-Bloecke. */
export function stripToolNarration(text: string): string {
  const withoutBlocks = text.replace(/\[\s*systemhinweis[^\]]*\][^.!?]*[.!?]?/gi, " ");
  return splitSentences(withoutBlocks)
    .filter((s) => !NARRATION.test(s))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Alle in einem Text genannten Uhrzeiten als "HH:MM" ("10 Uhr", "10:30", "10.30 Uhr"). */
export function extractTimes(text: string): Set<string> {
  const out = new Set<string>();
  const pad = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) out.add(pad(m[1], m[2]));
  for (const m of text.matchAll(/(?<![\d:.])\b(\d{1,2})(?:\.(\d{2}))?\s*Uhr\b/g)) out.add(pad(m[1], m[2] ?? "00"));
  return out;
}
