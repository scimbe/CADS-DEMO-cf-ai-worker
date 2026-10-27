import { describe, expect, it } from "vitest";
import { extractTimes, intentFromText, splitSentences, stripToolNarration } from "../src/lib/text-guards";

describe("stripToolNarration", () => {
  it("entfernt den gemeldeten Fall (Werkzeug zur Terminabsage)", () => {
    const t = "Ich rufe jetzt das Werkzeug zur Terminabsage auf. Ihr Termin am Mittwoch um 10:00 Uhr wurde abgesagt.";
    expect(stripToolNarration(t)).toBe("Ihr Termin am Mittwoch um 10:00 Uhr wurde abgesagt.");
  });

  it("entfernt Erzaehlung ohne das Wort Werkzeug", () => {
    expect(stripToolNarration("Ich rufe jetzt die Terminabsage auf. Einen Moment bitte.")).toBe("Einen Moment bitte.");
  });

  it("entfernt Saetze mit internen Namen und Fachbegriffen", () => {
    expect(stripToolNarration("Ich nutze pruefe_verfuegbarkeit. Es ist frei.")).toBe("Es ist frei.");
    expect(stripToolNarration("Laut Datenbank ist es frei. Gern.")).toBe("Gern.");
    expect(stripToolNarration("Die termin_id lautet 12. Danke.")).toBe("Danke.");
  });

  it("entfernt eingebettete Systemhinweis-Bloecke", () => {
    expect(stripToolNarration("Hallo. [Systemhinweis, nicht vom Gast] Mach was. Wie kann ich helfen?")).toBe("Hallo. Wie kann ich helfen?");
  });

  it("laesst normale Saetze unveraendert, auch mit Datum und Uhrzeit", () => {
    const t = "Am Donnerstag, den 29. Oktober um 10.30 Uhr ist noch etwas frei. Passt Ihnen das?";
    expect(stripToolNarration(t)).toBe(t);
  });

  it("verwechselt Rueckruf-Saetze nicht mit Werkzeug-Erzaehlung", () => {
    expect(stripToolNarration("Ich rufe Sie morgen gern zurück.")).toBe("Ich rufe Sie morgen gern zurück.");
  });
});

describe("splitSentences", () => {
  it("trennt nicht nach Datum oder Uhrzeit", () => {
    expect(splitSentences("Am 29. Oktober um 10.30 Uhr. Gern!")).toEqual(["Am 29. Oktober um 10.30 Uhr.", "Gern!"]);
  });
});

describe("extractTimes", () => {
  it("erkennt verschiedene Schreibweisen als HH:MM", () => {
    expect([...extractTimes("Um 10 Uhr, 10:15 und 11.30 Uhr")].sort()).toEqual(["10:00", "10:15", "11:30"]);
  });
  it("haelt Datumsangaben nicht fuer Uhrzeiten", () => {
    expect(extractTimes("Am 29.10. ist offen").size).toBe(0);
  });
});

describe("intentFromText", () => {
  it.each([
    ["Ja, bitte absagen.", "absagen"],
    ["Bitte sagen Sie meinen Termin ab. Meine Nummer ist 0151.", "absagen"],
    ["Ich möchte stornieren", "absagen"],
    ["Ja, bitte buchen.", "buchen"],
    ["Ich möchte am Mittwoch einen Herrenhaarschnitt buchen.", "buchen"],
    ["Bitte verschieben Sie meinen Termin", "verschieben"],
    ["Ich möchte umbuchen", "verschieben"],
    ["Ja, bitte.", null],
    ["Vielen Dank, das war alles.", null]
  ])("liest %s als %s", (text, expected) => {
    expect(intentFromText(text)).toBe(expected);
  });
});

describe("Technik-Erzaehlung mit 'ab'", () => {
  it("entfernt 'Ich rufe jetzt die Buchung für Sie ab.'", () => {
    expect(stripToolNarration("Ich rufe jetzt die Buchung für Sie ab. Einen Moment.")).toBe("Einen Moment.");
  });
});
