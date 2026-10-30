/**
 * Reine, Workers-unabhängige Kalenderlogik für die Friseur-Terminvergabe.
 * Keine Cloudflare-APIs hier drin -> direkt mit vitest testbar (siehe tests/calendar.test.ts).
 */

export const TIMEZONE = "Europe/Berlin";
export const SLOT_STEP_MIN = 15;
export const MIN_LEAD_MINUTES = 60;
export const BOOKING_HORIZON_DAYS = 60;

export interface BusinessHours {
  open: string; // "HH:mm"
  close: string; // "HH:mm"
}

/** 0 = Sonntag ... 6 = Samstag (wie Date#getUTCDay()) */
export const OPENING_HOURS: Record<number, BusinessHours | null> = {
  0: null,
  1: null, // Montag: Ruhetag
  2: { open: "09:00", close: "18:00" },
  3: { open: "09:00", close: "18:00" },
  4: { open: "09:00", close: "18:00" },
  5: { open: "09:00", close: "18:00" },
  6: { open: "09:00", close: "14:00" }
};

export const SERVICES = {
  schneiden_kurz: { label: "Waschen & Schneiden (kurzes Haar)", durationMin: 30 },
  schneiden_lang: { label: "Waschen & Schneiden (langes Haar)", durationMin: 45 },
  styling: { label: "Waschen & Föhnen", durationMin: 30 },
  faerben: { label: "Färben", durationMin: 90 },
  straehnen: { label: "Strähnen", durationMin: 90 },
  dauerwelle: { label: "Dauerwelle", durationMin: 120 }
} as const;

export type ServiceKey = keyof typeof SERVICES;
export const SERVICE_KEYS = Object.keys(SERVICES) as ServiceKey[];

export interface Appointment {
  id: string;
  customerName: string;
  phone: string;
  service: ServiceKey;
  startTs: number; // unix ms
  endTs: number; // unix ms
  status: "confirmed" | "cancelled";
  notes?: string | null;
  createdAt: number;
}

export interface Blocker {
  id: string;
  startTs: number; // unix ms
  endTs: number; // unix ms
  reason: string;
  createdAt: number;
}

interface Interval {
  startTs: number;
  endTs: number;
}

/** Offset (Minuten) einer Zeitzone zu UTC für einen bestimmten Zeitpunkt. */
function getOffsetMinutes(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(utcDate).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - utcDate.getTime()) / 60000;
}

/** Wandelt eine lokale Wanduhrzeit (z.B. "2026-09-10" "14:30") in Europe/Berlin in einen UTC-Zeitstempel (ms) um. */
export function zonedTimeToUtcMs(dateStr: string, timeStr: string, timeZone: string = TIMEZONE): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guessMs = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMin = getOffsetMinutes(new Date(guessMs), timeZone);
  return guessMs - offsetMin * 60000;
}

/** Kalenderdatum (Jahr/Monat/Tag) eines UTC-Zeitstempels in einer Zeitzone. */
export function getDateParts(ms: number, timeZone: string = TIMEZONE) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = dtf.formatToParts(new Date(ms)).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

/** "YYYY-MM-DD" eines Zeitstempels in der Salon-Zeitzone. */
export function toDateStr(ms: number, timeZone: string = TIMEZONE): string {
  const p = getDateParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "HH:mm" eines Zeitstempels in der Salon-Zeitzone. */
export function toTimeStr(ms: number, timeZone: string = TIMEZONE): string {
  const p = getDateParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const WEEKDAY_NAMES_DE = [
  "Sonntag",
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag"
];

/** Wochentag (0=So..6=Sa) eines Kalendertags "YYYY-MM-DD", zeitzonenunabhängig (reines Kalenderdatum). */
export function weekdayOfDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayNameDe(dateStr: string): string {
  return WEEKDAY_NAMES_DE[weekdayOfDateStr(dateStr)];
}

export function formatDateHumanDe(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${weekdayNameDe(dateStr)}, ${d}.${m}.${y}`;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startTs < b.endTs && b.startTs < a.endTs;
}

function activeIntervals(appointments: Appointment[], blockers: Blocker[]): Interval[] {
  return [
    ...appointments.filter((a) => a.status === "confirmed").map((a) => ({ startTs: a.startTs, endTs: a.endTs })),
    ...blockers.map((b) => ({ startTs: b.startTs, endTs: b.endTs }))
  ];
}

/**
 * Freie Slot-Startzeiten (unix ms, Salon-Zeitzone) für einen Kalendertag und eine Leistung.
 * `excludeAppointmentId` lässt einen bestehenden Termin bei der Umbuchung außen vor.
 */
export function getAvailableSlots(params: {
  dateStr: string;
  service: ServiceKey;
  appointments: Appointment[];
  blockers: Blocker[];
  now: number;
  excludeAppointmentId?: string;
}): number[] {
  const { dateStr, service, blockers, now, excludeAppointmentId } = params;
  const appointments = excludeAppointmentId
    ? params.appointments.filter((a) => a.id !== excludeAppointmentId)
    : params.appointments;

  const hours = OPENING_HOURS[weekdayOfDateStr(dateStr)];
  if (!hours) return [];

  const durationMs = SERVICES[service].durationMin * 60000;
  const dayStart = zonedTimeToUtcMs(dateStr, hours.open);
  const dayEnd = zonedTimeToUtcMs(dateStr, hours.close);
  const stepMs = SLOT_STEP_MIN * 60000;
  const earliestStart = Math.max(dayStart, now + MIN_LEAD_MINUTES * 60000);
  const busy = activeIntervals(appointments, blockers);

  const slots: number[] = [];
  for (let t = dayStart; t + durationMs <= dayEnd; t += stepMs) {
    if (t < earliestStart) continue;
    const candidate = { startTs: t, endTs: t + durationMs };
    if (busy.some((b) => overlaps(candidate, b))) continue;
    slots.push(t);
  }
  return slots;
}

export function isSlotFree(params: {
  startTs: number;
  endTs: number;
  appointments: Appointment[];
  blockers: Blocker[];
  excludeAppointmentId?: string;
}): boolean {
  const { startTs, endTs, blockers, excludeAppointmentId } = params;
  const appointments = excludeAppointmentId
    ? params.appointments.filter((a) => a.id !== excludeAppointmentId)
    : params.appointments;
  const busy = activeIntervals(appointments, blockers);
  return !busy.some((b) => overlaps({ startTs, endTs }, b));
}

export function isWithinBookingHorizon(dateStr: string, now: number): boolean {
  const ms = zonedTimeToUtcMs(dateStr, "00:00");
  const horizonMs = now + BOOKING_HORIZON_DAYS * 24 * 60 * 60000;
  return ms <= horizonMs;
}

export type BookableStatus = "ok" | "ungueltig" | "zu_kurzfristig" | "zu_weit_in_zukunft" | "geschlossen" | "ausserhalb_oeffnungszeiten";

/**
 * Darf zu dieser Zeit ueberhaupt ein Termin beginnen? Unabhaengig von Kollisionen (isSlotFree).
 * Gilt fuer jede schreibende Aktion: Das Modell allein darf nie entscheiden, ob der Salon offen hat.
 */
export function checkBookable(params: { dateStr: string; timeStr: string; service: ServiceKey; now: number }): BookableStatus {
  const { dateStr, timeStr, service, now } = params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) return "ungueltig";
  const startTs = zonedTimeToUtcMs(dateStr, timeStr);
  if (!Number.isFinite(startTs) || toDateStr(startTs) !== dateStr) return "ungueltig";
  if (startTs < now + MIN_LEAD_MINUTES * 60000) return "zu_kurzfristig";
  if (!isWithinBookingHorizon(dateStr, now)) return "zu_weit_in_zukunft";
  const hours = OPENING_HOURS[weekdayOfDateStr(dateStr)];
  if (!hours) return "geschlossen";
  const endTs = startTs + SERVICES[service].durationMin * 60000;
  if (startTs < zonedTimeToUtcMs(dateStr, hours.open) || endTs > zonedTimeToUtcMs(dateStr, hours.close)) {
    return "ausserhalb_oeffnungszeiten";
  }
  return "ok";
}
