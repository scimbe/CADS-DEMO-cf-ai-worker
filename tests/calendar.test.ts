import { describe, expect, it } from "vitest";
import {
  getAvailableSlots,
  isSlotFree,
  isWithinBookingHorizon,
  zonedTimeToUtcMs,
  toDateStr,
  toTimeStr,
  weekdayNameDe,
  type Appointment,
  type Blocker
} from "../src/lib/calendar";

// 2026-09-10 ist ein Donnerstag (regulärer Öffnungstag, 09:00-18:00).
// 2026-09-07 ist ein Montag (Ruhetag).
const THURSDAY = "2026-09-10";
const MONDAY = "2026-09-07";

function appt(overrides: Partial<Appointment>): Appointment {
  return {
    id: "a1",
    customerName: "Max Mustermann",
    phone: "0170",
    service: "schneiden_kurz",
    startTs: 0,
    endTs: 0,
    status: "confirmed",
    createdAt: 0,
    ...overrides
  };
}

function blocker(overrides: Partial<Blocker>): Blocker {
  return { id: "b1", startTs: 0, endTs: 0, reason: "Urlaub", createdAt: 0, ...overrides };
}

describe("Zeitumrechnung Europe/Berlin", () => {
  it("wandelt lokale Wanduhrzeit korrekt in UTC um und zurück", () => {
    const ms = zonedTimeToUtcMs(THURSDAY, "14:30");
    expect(toDateStr(ms)).toBe(THURSDAY);
    expect(toTimeStr(ms)).toBe("14:30");
  });

  it("erkennt den Wochentag korrekt", () => {
    expect(weekdayNameDe(THURSDAY)).toBe("Donnerstag");
    expect(weekdayNameDe(MONDAY)).toBe("Montag");
  });
});

describe("getAvailableSlots", () => {
  const earlyNow = zonedTimeToUtcMs(THURSDAY, "00:00") - 24 * 3600_000; // ein Tag vorher, keine Lead-Time-Konflikte

  it("liefert keine Slots am Ruhetag (Montag)", () => {
    const slots = getAvailableSlots({
      dateStr: MONDAY,
      service: "schneiden_kurz",
      appointments: [],
      blockers: [],
      now: earlyNow
    });
    expect(slots).toEqual([]);
  });

  it("liefert Slots innerhalb der Öffnungszeiten an einem normalen Tag", () => {
    const slots = getAvailableSlots({
      dateStr: THURSDAY,
      service: "schneiden_kurz", // 30 Min
      appointments: [],
      blockers: [],
      now: earlyNow
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(toTimeStr(slots[0])).toBe("09:00");
    expect(toTimeStr(slots[slots.length - 1])).toBe("17:30"); // letzter Slot, der + 30min noch <= 18:00 passt
  });

  it("schließt Slots aus, die mit einem bestehenden Termin überlappen", () => {
    const bookedStart = zonedTimeToUtcMs(THURSDAY, "10:00");
    const bookedEnd = zonedTimeToUtcMs(THURSDAY, "10:30");
    const slots = getAvailableSlots({
      dateStr: THURSDAY,
      service: "schneiden_kurz",
      appointments: [appt({ startTs: bookedStart, endTs: bookedEnd })],
      blockers: [],
      now: earlyNow
    });
    expect(slots.map((s) => toTimeStr(s))).not.toContain("10:00");
    expect(slots.map((s) => toTimeStr(s))).toContain("09:00");
  });

  it("schließt Slots aus, die mit einem Blocker überlappen", () => {
    const blockStart = zonedTimeToUtcMs(THURSDAY, "09:00");
    const blockEnd = zonedTimeToUtcMs(THURSDAY, "12:00");
    const slots = getAvailableSlots({
      dateStr: THURSDAY,
      service: "schneiden_kurz",
      appointments: [],
      blockers: [blocker({ startTs: blockStart, endTs: blockEnd })],
      now: earlyNow
    });
    expect(slots.every((s) => toTimeStr(s) >= "12:00")).toBe(true);
  });

  it("ignoriert stornierte Termine bei der Verfügbarkeit", () => {
    const bookedStart = zonedTimeToUtcMs(THURSDAY, "10:00");
    const bookedEnd = zonedTimeToUtcMs(THURSDAY, "10:30");
    const slots = getAvailableSlots({
      dateStr: THURSDAY,
      service: "schneiden_kurz",
      appointments: [appt({ startTs: bookedStart, endTs: bookedEnd, status: "cancelled" })],
      blockers: [],
      now: earlyNow
    });
    expect(slots.map((s) => toTimeStr(s))).toContain("10:00");
  });

  it("respektiert die Mindestvorlaufzeit (keine Slots in der Vergangenheit/zu kurzfristig)", () => {
    const now = zonedTimeToUtcMs(THURSDAY, "09:30");
    const slots = getAvailableSlots({
      dateStr: THURSDAY,
      service: "schneiden_kurz",
      appointments: [],
      blockers: [],
      now
    });
    expect(slots.every((s) => s >= now + 60 * 60000)).toBe(true);
  });
});

describe("isSlotFree", () => {
  it("erkennt eine Kollision", () => {
    const start = zonedTimeToUtcMs(THURSDAY, "10:00");
    const end = zonedTimeToUtcMs(THURSDAY, "10:30");
    const free = isSlotFree({
      startTs: start,
      endTs: end,
      appointments: [appt({ startTs: start, endTs: end })],
      blockers: []
    });
    expect(free).toBe(false);
  });

  it("erlaubt den eigenen Termin bei Umbuchung (excludeAppointmentId)", () => {
    const start = zonedTimeToUtcMs(THURSDAY, "10:00");
    const end = zonedTimeToUtcMs(THURSDAY, "10:30");
    const free = isSlotFree({
      startTs: start,
      endTs: end,
      appointments: [appt({ id: "self", startTs: start, endTs: end })],
      blockers: [],
      excludeAppointmentId: "self"
    });
    expect(free).toBe(true);
  });
});

describe("isWithinBookingHorizon", () => {
  it("lehnt Daten weit in der Zukunft ab", () => {
    const now = zonedTimeToUtcMs(THURSDAY, "10:00");
    const farDate = toDateStr(now + 120 * 24 * 3600_000);
    expect(isWithinBookingHorizon(farDate, now)).toBe(false);
  });

  it("akzeptiert Daten innerhalb von 60 Tagen", () => {
    const now = zonedTimeToUtcMs(THURSDAY, "10:00");
    const soonDate = toDateStr(now + 5 * 24 * 3600_000);
    expect(isWithinBookingHorizon(soonDate, now)).toBe(true);
  });
});
