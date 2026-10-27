// Deterministisches Lesen deutscher Datumsangaben ("Mittwoch", "morgen", "29. Oktober", "29.10.").
import { toDateStr, weekdayNameDe, weekdayOfDateStr, zonedTimeToUtcMs } from "./calendar";

const DAY_MS = 86_400_000;

const WEEKDAYS: Array<[string, number]> = [
  ["sonntag", 0],
  ["montag", 1],
  ["dienstag", 2],
  ["mittwoch", 3],
  ["donnerstag", 4],
  ["freitag", 5],
  ["samstag", 6],
  ["sonnabend", 6]
];

export const MONTH_NAMES_DE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember"
];

const MONTH_LOOKUP: Record<string, number> = {
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12
};

export function addDays(dateStr: string, n: number): string {
  return toDateStr(zonedTimeToUtcMs(dateStr, "12:00") + n * DAY_MS);
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Mittwoch, den 28. Oktober 2026" */
export function longDateDe(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${weekdayNameDe(dateStr)}, den ${d}. ${MONTH_NAMES_DE[m - 1]} ${y}`;
}

/**
 * Liest eine Datumsangabe relativ zu `nowMs`. Wochentage bedeuten das naechste Auftreten
 * NACH heute. Tag/Monat ohne Jahr bedeuten das naechste Auftreten ab heute.
 */
export function parseDatumDe(input: string | null | undefined, nowMs: number): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const today = toDateStr(nowMs);

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // \b kennt keine Umlaute: eigene Wortgrenzen.
  if (/(?<![a-zäöü])(übermorgen|uebermorgen)(?![a-zäöü])/.test(s)) return addDays(today, 2);
  if (/(?<![a-zäöü])morgen(?![a-zäöü])/.test(s)) return addDays(today, 1);
  if (/\bheute\b/.test(s)) return today;

  const named = /(\d{1,2})\.?\s*(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\b\s*(\d{4})?/.exec(s);
  const numeric = /(\d{1,2})\.(\d{1,2})\.?(?:(\d{4}))?/.exec(s);
  const dm = named
    ? { d: Number(named[1]), m: MONTH_LOOKUP[named[2]], y: named[3] ? Number(named[3]) : undefined }
    : numeric
      ? { d: Number(numeric[1]), m: Number(numeric[2]), y: numeric[3] ? Number(numeric[3]) : undefined }
      : null;
  if (dm) {
    const thisYear = Number(today.slice(0, 4));
    if (dm.y !== undefined) return validDate(dm.y, dm.m, dm.d);
    const candidate = validDate(thisYear, dm.m, dm.d);
    if (candidate && candidate >= today) return candidate;
    return validDate(thisYear + 1, dm.m, dm.d);
  }

  for (const [name, idx] of WEEKDAYS) {
    if (s.includes(name)) {
      let diff = (idx - weekdayOfDateStr(today) + 7) % 7;
      if (diff === 0) diff = 7;
      return addDays(today, diff);
    }
  }
  return null;
}
