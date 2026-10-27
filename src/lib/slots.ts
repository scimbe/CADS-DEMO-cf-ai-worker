// Aufbereitung freier Slots fuer die Verfuegbarkeitspruefung.
// Das Sprachmodell tippt Uhrzeiten sonst gern neu ab ("09:0 Uhr") oder laesst Eintraege weg.
// Daher liefert das Werkzeug eine vollstaendige, nullgepolsterte Liste (HH:MM) und einen
// fertigen Satz mit zusammengefassten Zeitfenstern, den das Modell woertlich uebernehmen soll.

export interface SlotSummary {
  /** Alle freien Startzeiten, vollstaendig, "HH:MM" nullgepolstert. */
  freie_zeiten: string[];
  /** Zusammenhaengende Fenster, z.B. "09:00 bis 12:30 Uhr". */
  zeitfenster: string[];
  /** Fertiger Satz zur woertlichen Uebernahme. */
  antwort_text: string;
}

export function padTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  return `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function summarizeSlots(times: readonly string[], stepMin: number): SlotSummary {
  const sorted = [...new Set(times.map(padTime))].sort((a, b) => toMinutes(a) - toMinutes(b));
  const windows: string[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const contiguous = i < sorted.length && toMinutes(sorted[i]) - toMinutes(sorted[i - 1]) === stepMin;
    if (!contiguous) {
      const first = sorted[start];
      const last = sorted[i - 1];
      windows.push(first === last ? `${first} Uhr` : `${first} bis ${last} Uhr`);
      start = i;
    }
  }
  const antwort_text =
    sorted.length === 0
      ? "Es sind keine freien Zeiten vorhanden."
      : `Als Startzeit frei (alle ${stepMin} Minuten): ${windows.join(", ")}.`;
  return { freie_zeiten: sorted, zeitfenster: windows, antwort_text };
}
