import { describe, expect, it, vi } from "vitest";
import { normalizeLeistung, parseExtraction, recoverTurn, renderToolOutput, transcriptFrom, type Extracted } from "../src/lib/recovery";

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0); // Dienstag 27.10.2026

function run(extracted: Extracted | null, outputs: Record<string, Record<string, unknown>> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    return outputs[name] ?? { status: "fehler" };
  });
  const promise = recoverTurn({ extract: async () => extracted, callTool, nowMs: NOW });
  return { promise, calls };
}

const FREE = { status: "ok", antwort_text: "Als Startzeit frei (alle 15 Minuten): 09:00 bis 17:30 Uhr.", gewuenschte_zeit: { zeit: "10:00", frei: true, antwort_text: "10:00 Uhr ist frei." } };

describe("recoverTurn", () => {
  it("prueft die Verfuegbarkeit deterministisch (Buchungswunsch ohne Bestaetigung) und bucht NICHT", async () => {
    const { promise, calls } = run(
      { aktion: "buchen", bestaetigt: false, name: "TEST A", telefon: "0151 1", leistung: "schneiden_kurz", datum_text: "Mittwoch", uhrzeit_text: "10 Uhr" },
      { pruefe_verfuegbarkeit: FREE }
    );
    const out = await promise;
    expect(calls).toEqual([["pruefe_verfuegbarkeit", { datum: "2026-10-28", leistung: "schneiden_kurz", uhrzeit: "10:00" }]]);
    expect(out).toBe("Am Mittwoch, den 28. Oktober 2026 ist 10:00 Uhr frei. Soll ich den Termin für TEST A verbindlich buchen?");
  });

  it("fragt fehlende Angaben nach, statt zu raten", async () => {
    const { promise, calls } = run(
      { aktion: "buchen", bestaetigt: false, leistung: "schneiden_kurz", datum_text: "Mittwoch", uhrzeit_text: "10 Uhr" },
      { pruefe_verfuegbarkeit: FREE }
    );
    expect(await promise).toContain("Dafür brauche ich noch Ihren Namen und Ihre Telefonnummer.");
    expect(calls.map((c) => c[0])).toEqual(["pruefe_verfuegbarkeit"]);
  });

  it("bucht nur mit ausdruecklicher Bestaetigung und vollstaendigen Angaben", async () => {
    const { promise, calls } = run(
      { aktion: "buchen", bestaetigt: true, name: "TEST A", telefon: "0151 1", leistung: "Herrenhaarschnitt", datum_text: "Mittwoch", uhrzeit_text: "10 Uhr" },
      { termin_buchen: { status: "gebucht", bestaetigung: "Mittwoch, 28.10.2026 um 10:00 Uhr" } }
    );
    const out = await promise;
    expect(calls).toEqual([["termin_buchen", { name: "TEST A", telefon: "0151 1", leistung: "schneiden_kurz", datum: "2026-10-28", uhrzeit: "10:00" }]]);
    expect(out).toContain("fest gebucht");
  });

  it("bucht nicht, wenn Angaben fehlen, auch bei Bestaetigung", async () => {
    const { promise, calls } = run({ aktion: "buchen", bestaetigt: true, name: "TEST A", leistung: "schneiden_kurz", datum_text: "Mittwoch", uhrzeit_text: "10 Uhr" });
    expect(await promise).toBe("Dafür brauche ich noch Ihre Telefonnummer.");
    expect(calls).toEqual([]);
  });

  it("sucht den Termin vor dem Absagen und sagt erst nach Bestaetigung ab", async () => {
    const search = run({ aktion: "absagen", bestaetigt: false, telefon: "0151 1" }, { termine_suchen: { status: "ok", termine: [{ wann: "Mittwoch, 28.10.2026 um 10:00 Uhr" }] } });
    expect(await search.promise).toBe("Ich habe Ihren Termin am Mittwoch, 28.10.2026 um 10:00 Uhr gefunden. Soll ich ihn absagen?");
    expect(search.calls.map((c) => c[0])).toEqual(["termine_suchen"]);

    const cancel = run({ aktion: "absagen", bestaetigt: true, telefon: "0151 1" }, { termin_absagen: { status: "abgesagt", wann: "Mittwoch, 28.10.2026 um 10:00 Uhr" } });
    expect(await cancel.promise).toBe("Ihr Termin am Mittwoch, 28.10.2026 um 10:00 Uhr wurde abgesagt.");
    expect(cancel.calls).toEqual([["termin_absagen", { telefon: "0151 1" }]]);
  });

  it("meldet nicht gefundene Termine ehrlich", async () => {
    const { promise } = run({ aktion: "absagen", bestaetigt: false, telefon: "0151 1" }, { termine_suchen: { status: "keine_termine" } });
    expect(await promise).toBe("Unter dieser Nummer habe ich keinen Termin gefunden.");
  });

  it("nennt Alternativen, wenn die Wunschzeit nicht frei ist", async () => {
    const { promise } = run(
      { aktion: "pruefen", leistung: "schneiden_kurz", datum_text: "Mittwoch", uhrzeit_text: "10 Uhr" },
      { pruefe_verfuegbarkeit: { status: "ok", gewuenschte_zeit: { zeit: "10:00", frei: false, antwort_text: "10:00 Uhr ist nicht frei. Naechste freie Zeiten: 10:15 Uhr." } } }
    );
    expect(await promise).toContain("10:00 Uhr ist nicht frei.");
  });

  it("liefert null, wenn keine Aktion erkennbar ist oder die Extraktion scheitert", async () => {
    expect(await run({ aktion: "keine" }).promise).toBeNull();
    expect(await run(null).promise).toBeNull();
  });
});

describe("renderToolOutput", () => {
  it("formuliert Ergebnisse und schweigt bei Unbekanntem", () => {
    expect(renderToolOutput("termin_buchen", { status: "belegt" })).toContain("schon vergeben");
    expect(renderToolOutput("termin_buchen", { status: "gebucht", bestaetigung: "X" })).toContain("fest gebucht");
    expect(renderToolOutput("pruefe_verfuegbarkeit", { status: "ok" })).toBeNull();
  });
});

describe("normalizeLeistung", () => {
  it.each([
    ["Herrenhaarschnitt", "schneiden_kurz"],
    ["schneiden_kurz", "schneiden_kurz"],
    ["Haare färben", "faerben"],
    ["Strähnen", "straehnen"],
    ["Waschen und Föhnen", "styling"],
    ["Schnitt, langes Haar", "schneiden_lang"],
    ["Massage", null]
  ])("ordnet %s zu %s", (input, expected) => {
    expect(normalizeLeistung(input)).toBe(expected);
  });
});

describe("parseExtraction / transcriptFrom", () => {
  it("liest JSON auch mit Code-Fence und Begleittext", () => {
    expect(parseExtraction('Hier:\n```json\n{"aktion":"buchen","bestaetigt":true}\n```')).toEqual({ aktion: "buchen", bestaetigt: true });
    expect(parseExtraction("kein json")).toBeNull();
    expect(parseExtraction("{kaputt")).toBeNull();
  });

  it("baut den Verlauf aus Text- und Teile-Nachrichten", () => {
    const t = transcriptFrom([
      { role: "user", content: "Haben Sie morgen frei?" },
      { role: "assistant", content: [{ type: "text", text: "Ja, gern, wann genau?" }] },
      { role: "tool", content: [] }
    ]);
    expect(t).toBe("Gast: Haben Sie morgen frei?\nAssistent: Ja, gern, wann genau?");
  });

  it("vergisst erledigte Anliegen: nach einer abgeschlossenen Absage zaehlt nur das neue Anliegen", () => {
    const t = transcriptFrom([
      { role: "user", content: "Ich muss den Termin am Donnerstag absagen. 0170 0000000." },
      { role: "assistant", content: "Möchten Sie diesen Termin wirklich absagen?" },
      { role: "user", content: "Ja, bitte absagen." },
      { role: "assistant", content: "Ihr Termin am Donnerstag, 29.10.2026 um 14:00 Uhr wurde erfolgreich abgesagt." },
      { role: "user", content: "Und welche Zeiten sind am Donnerstag, dem 5. November, frei?" },
      { role: "assistant", content: "Dafür brauche ich noch die gewünschte Leistung." },
      { role: "user", content: "Einen Haarschnitt." }
    ]);
    expect(t).not.toMatch(/absagen|0170/);
    expect(t.split("\n")[0]).toBe("Gast: Und welche Zeiten sind am Donnerstag, dem 5. November, frei?");
  });
});
