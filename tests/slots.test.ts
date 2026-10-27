import { describe, expect, it } from "vitest";
import { padTime, summarizeSlots } from "../src/lib/slots";

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
    expect(r.antwort_text).toBe("Als Startzeit frei (alle 15 Minuten): 09:00 bis 17:15 Uhr.");
  });

  it("trennt Fenster an Luecken (belegte Termine)", () => {
    const r = summarizeSlots(["09:00", "09:15", "09:30", "11:00", "11:15", "15:45"], 15);
    expect(r.zeitfenster).toEqual(["09:00 bis 09:30 Uhr", "11:00 bis 11:15 Uhr", "15:45 Uhr"]);
    expect(r.antwort_text).toContain("09:00 bis 09:30 Uhr, 11:00 bis 11:15 Uhr, 15:45 Uhr");
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
