import { describe, expect, it } from "vitest";
import { longDateDe, parseDatumDe } from "../src/lib/dates-de";

// Dienstag, 27.10.2026
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

describe("parseDatumDe", () => {
  it.each([
    ["Mittwoch", "2026-10-28"],
    ["am Mittwoch", "2026-10-28"],
    ["Donnerstag", "2026-10-29"],
    ["Dienstag", "2026-11-03"], // heute ist Dienstag: naechstes Auftreten
    ["morgen", "2026-10-28"],
    ["übermorgen", "2026-10-29"],
    ["heute", "2026-10-27"],
    ["29. Oktober", "2026-10-29"],
    ["29.10.", "2026-10-29"],
    ["29.10.2026", "2026-10-29"],
    ["1. Oktober", "2027-10-01"], // schon vorbei -> naechstes Jahr
    ["2026-10-30", "2026-10-30"]
  ])("liest %s als %s", (input, expected) => {
    expect(parseDatumDe(input, NOW)).toBe(expected);
  });

  it("lehnt Unsinn und ungueltige Daten ab", () => {
    expect(parseDatumDe("irgendwann", NOW)).toBeNull();
    expect(parseDatumDe("31.02.", NOW)).toBeNull();
    expect(parseDatumDe("", NOW)).toBeNull();
    expect(parseDatumDe(null, NOW)).toBeNull();
  });
});

describe("longDateDe", () => {
  it("formatiert ausgeschrieben", () => {
    expect(longDateDe("2026-10-28")).toBe("Mittwoch, den 28. Oktober 2026");
  });
});
