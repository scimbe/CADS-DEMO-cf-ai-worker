import { describe, expect, it } from "vitest";
import { checkRequestedTime, padTime, parseUhrzeit, summarizeSlots } from "../src/lib/slots";

describe("padTime", () => {
  it("polstert Stunden und Minuten mit Nullen", () => {
    expect(padTime("9:0")).toBe("09:00");
    expect(padTime("9:5")).toBe("09:05");
    expect(padTime("14:30")).toBe("14:30");
  });
});

describe("summarizeSlots", () => {
  it("liefert vollstaendige, nullgepolsterte Zeiten ohne Kappung", () => {
    const times: string[] = [];
    for (let m = 9 * 60; m <= 17 * 60 + 15; m += 15) {
      times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
    const r = summarizeSlots(times, 15);
    expect(r.freie_zeiten).toHaveLength(times.length); // kein slice(0, 8) mehr
    expect(r.freie_zeiten[0]).toBe("09:00");
    expect(r.freie_zeiten.every((t) => /^\d{2}:\d{2}$/.test(t))).toBe(true);
    expect(r.zeitfenster).toEqual(["09:00 bis 17:15 Uhr"]);
    expect(r.antwort_text).toBe("Frei ist von 09:00 bis 17:15 Uhr.");
  });

  it("trennt Fenster an Luecken (belegte Termine)", () => {
    const r = summarizeSlots(["09:00", "09:15", "09:30", "11:00", "11:15", "15:45"], 15);
    expect(r.zeitfenster).toEqual(["09:00 bis 09:30 Uhr", "11:00 bis 11:15 Uhr", "15:45 Uhr"]);
    expect(r.antwort_text).toBe("Frei ist von 09:00 bis 09:30 Uhr, von 11:00 bis 11:15 Uhr und um 15:45 Uhr.");
  });

  it("liest am Telefon hoechstens drei Zeitfenster vor, nie jede Startzeit", () => {
    const r = summarizeSlots(["09:00", "10:00", "11:00", "12:00", "13:00"], 15);
    expect(r.antwort_text).toBe("Frei ist zum Beispiel um 09:00 Uhr, um 10:00 Uhr oder um 11:00 Uhr.");
    expect(r.freie_zeiten).toHaveLength(5);
  });

  it("sortiert, entfernt Duplikate und polstert unvollstaendige Eingaben", () => {
    const r = summarizeSlots(["9:15", "09:00", "9:0", "09:30"], 15);
    expect(r.freie_zeiten).toEqual(["09:00", "09:15", "09:30"]);
    expect(r.zeitfenster).toEqual(["09:00 bis 09:30 Uhr"]);
  });

  it("meldet leere Listen eindeutig", () => {
    const r = summarizeSlots([], 15);
    expect(r.freie_zeiten).toEqual([]);
    expect(r.antwort_text).toBe("Es sind keine freien Zeiten vorhanden.");
  });
});

describe("parseUhrzeit", () => {
  it.each([
    ["10", "10:00"],
    ["10 Uhr", "10:00"],
    ["10:00", "10:00"],
    ["10.30 Uhr", "10:30"],
    ["9h", "09:00"],
    ["9:5", "09:05"],
    [" 14 uhr ", "14:00"]
  ])("liest %s als %s", (input, expected) => {
    expect(parseUhrzeit(input)).toBe(expected);
  });

  it("lehnt Unlesbares und Ungueltiges ab", () => {
    expect(parseUhrzeit("morgens")).toBeNull();
    expect(parseUhrzeit("25 Uhr")).toBeNull();
    expect(parseUhrzeit("10:75")).toBeNull();
    expect(parseUhrzeit(undefined)).toBeNull();
    expect(parseUhrzeit("")).toBeNull();
  });
});

describe("checkRequestedTime", () => {
  const free = ["09:00", "09:15", "10:00", "10:15", "11:00"];

  it("meldet eine freie Zeit als frei (10 Uhr bei 35/35 frei)", () => {
    const r = checkRequestedTime("10:00", free);
    expect(r.frei).toBe(true);
    expect(r.antwort_text).toBe("10:00 Uhr ist frei.");
  });

  it("meldet eine nicht freie Zeit mit den naechsten Alternativen", () => {
    const r = checkRequestedTime("10:30", free);
    expect(r.frei).toBe(false);
    expect(r.naechste_freie_zeiten).toEqual(["10:00", "10:15", "11:00"]);
    expect(r.antwort_text).toContain("10:30 Uhr ist nicht frei.");
  });

  it("polstert die angefragte Zeit", () => {
    expect(checkRequestedTime("9:0", free).frei).toBe(true);
  });
});
