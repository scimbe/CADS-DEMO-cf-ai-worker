import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FALLBACK_SENTENCE, UNBACKED_SENTENCE, runTurnWithRepair, type StreamPartLike } from "../src/lib/turn-runner";

async function* parts(...p: StreamPartLike[]): AsyncGenerator<StreamPartLike> {
  for (const x of p) yield x;
}
const text = (t: string): StreamPartLike => ({ type: "text-delta", text: t });

function makeTools(executed: unknown[]) {
  return {
    termine_suchen: {
      inputSchema: z.object({ telefon: z.string() }),
      execute: async (a: { telefon: string }) => {
        executed.push(a);
        return { status: "keine_termine" };
      }
    }
  } as never;
}

describe("runTurnWithRepair", () => {
  it("fuehrt als Text ausgegebene Werkzeugaufrufe aus und liefert die Folgeantwort", async () => {
    const executed: unknown[] = [];
    const calls: unknown[][] = [];
    const stream = vi.fn((_p: string, messages: unknown[]) => {
      calls.push(messages);
      return calls.length === 1
        ? parts(text('Einen Moment. {"type":"function","name":"termine_suchen","parameters":{"telefon":"0151"}}'))
        : parts(text("Unter dieser Nummer habe ich keinen Termin gefunden."));
    });
    const out = await runTurnWithRepair({ providers: ["workers-ai"], stream, tools: makeTools(executed), messages: [] });
    expect(out).toBe("Unter dieser Nummer habe ich keinen Termin gefunden.");
    expect(executed).toEqual([{ telefon: "0151" }]);
    expect(stream).toHaveBeenCalledTimes(2);
    // Folgeaufruf enthaelt Tool-Call und Tool-Result
    expect(JSON.stringify(calls[1])).toContain("tool-result");
  });

  it("zeigt nie rohes JSON, auch bei ungueltigen Parametern", async () => {
    const executed: unknown[] = [];
    let n = 0;
    const stream = () =>
      ++n === 1
        ? parts(text('{"name":"termine_suchen","parameters":{"telefon":123}}'))
        : parts(text("Wie lautet Ihre Telefonnummer?"));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools(executed), messages: [] });
    expect(out).toBe("Wie lautet Ihre Telefonnummer?");
    expect(executed).toEqual([]); // Schema lehnt ab, Werkzeug nicht ausgefuehrt
  });

  it("wiederholt bei leerer Antwort, dann Erfolg", async () => {
    let n = 0;
    const stream = () => (++n === 1 ? parts() : parts(text("Guten Tag!")));
    expect(await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [] })).toBe("Guten Tag!");
    expect(n).toBe(2);
  });

  it("wechselt bei Fehler zum naechsten Anbieter", async () => {
    const stream = (p: string) => (p === "a" ? parts({ type: "error", error: "1031" }) : parts(text("Hallo vom Fallback.")));
    expect(await runTurnWithRepair({ providers: ["a", "b"], stream, tools: makeTools([]), messages: [] })).toBe("Hallo vom Fallback.");
  });

  it("liefert den Ersatzsatz, wenn alles leer bleibt", async () => {
    const stream = () => parts();
    expect(await runTurnWithRepair({ providers: ["a", "b"], stream, tools: makeTools([]), messages: [] })).toBe(FALLBACK_SENTENCE);
  });

  it("wiederholt NICHT, wenn ein natives Werkzeug schon gelaufen ist (keine Doppelbuchung)", async () => {
    const stream = vi.fn(() => parts({ type: "tool-result" }));
    const out = await runTurnWithRepair({ providers: ["a", "b"], stream, tools: makeTools([]), messages: [] });
    expect(out).toBe(FALLBACK_SENTENCE);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("begrenzt die Folgerunden bei endloser Aufruf-Schleife", async () => {
    const executed: unknown[] = [];
    const stream = () => parts(text('{"name":"termine_suchen","parameters":{"telefon":"1"}}'));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools(executed), messages: [], maxLeakedRounds: 2 });
    expect(out).toBe(FALLBACK_SENTENCE);
    expect(executed.length).toBeLessThanOrEqual(3);
  });

  it("entdoppelt doppelt gelieferte Text-Deltas nur fuer Anbieter mit doubledDeltaProviders", async () => {
    const stream = () => parts(text("Gu"), text("Gu"), text("ten"), text("ten"), text(" Tag"), text(" Tag"));
    const opts = { providers: ["a"], stream, tools: makeTools([]), messages: [] };
    expect(await runTurnWithRepair({ ...opts, doubledDeltaProviders: ["a"] })).toBe("Guten Tag");
  });

  it("zerstoert keine echten Wiederholungen: '09:00' bleibt bei normalen Anbietern erhalten", async () => {
    const stream = () => parts(text("09"), text(":"), text("0"), text("0"), text(" Uhr"));
    expect(await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [] })).toBe("09:00 Uhr");
  });

  it("bewahrt echte Wiederholungen auch im doppelt gelieferten Stream (4x '0' -> '00')", async () => {
    const stream = () =>
      parts(text("09"), text("09"), text(":"), text(":"), text("0"), text("0"), text("0"), text("0"), text(" Uhr"), text(" Uhr"));
    expect(
      await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], doubledDeltaProviders: ["a"] })
    ).toBe("09:00 Uhr");
  });

  describe("Schutz vor erfundenen Erfolgsmeldungen", () => {
    const guards = [{ pattern: /\bgebucht\b/i, tools: ["termin_buchen"] }];
    const buchTools = (executed: unknown[]) =>
      ({
        termin_buchen: {
          inputSchema: z.object({ name: z.string() }),
          execute: async (a: { name: string }) => {
            executed.push(a);
            return { status: "gebucht" };
          }
        }
      }) as never;

    it("erzwingt das Werkzeug, wenn 'gebucht' ohne Aufruf behauptet wird", async () => {
      const executed: unknown[] = [];
      let n = 0;
      const stream = () => {
        n++;
        if (n === 1) return parts(text("Ihr Termin ist fest gebucht."));
        if (n === 2) return parts(text('{"name":"termin_buchen","parameters":{"name":"Anna"}}'));
        return parts(text("Dann ist der Termin jetzt gebucht, bis bald."));
      };
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools(executed), messages: [], claimGuards: guards });
      expect(executed).toEqual([{ name: "Anna" }]);
      expect(out).toBe("Dann ist der Termin jetzt gebucht, bis bald.");
    });

    it("liefert nie eine unbelegte Erfolgsmeldung", async () => {
      const stream = () => parts(text("Ihr Termin ist fest gebucht."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools([]), messages: [], claimGuards: guards });
      expect(out).toBe(UNBACKED_SENTENCE);
    });

    it("akzeptiert die Meldung, wenn ein natives Werkzeug erfolgreich lief", async () => {
      const stream = () =>
        parts({ type: "tool-result", toolName: "termin_buchen", output: { status: "gebucht" } }, text("Ihr Termin ist gebucht."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools([]), messages: [], claimGuards: guards });
      expect(out).toBe("Ihr Termin ist gebucht.");
    });

    it("lehnt die Meldung ab, wenn das Werkzeug nur 'belegt' lieferte", async () => {
      const stream = () =>
        parts({ type: "tool-result", toolName: "termin_buchen", output: { status: "belegt" } }, text("Ihr Termin ist gebucht."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools([]), messages: [], claimGuards: guards });
      expect(out).toBe(UNBACKED_SENTENCE);
    });
  });
});

describe("Anrede, Werkzeug-Erzaehlung und unbelegte Nicht-frei-Aussagen", () => {
  const DU = /\b(du|dir|dich|dein|deine|deinen|deinem|deiner|deines)\b/i;
  const UNAVAIL =
    /\b(vergeben|belegt|ausgebucht|besetzt)\b|\bnicht\s+(mehr\s+)?(frei|verf[uü]gbar)\b|\bnichts\s+(mehr\s+)?frei\b/i;
  const guards = [
    { mode: "unavailable" as const, pattern: UNAVAIL },
    { mode: "style" as const, pattern: DU }
  ];
  const tools = makeTools([]);

  it("erzwingt die Sie-Anrede mit einem Korrekturversuch", async () => {
    let n = 0;
    const stream = () => (++n === 1 ? parts(text("Dein Termin ist bestätigt.")) : parts(text("Ihr Termin ist bestätigt.")));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe("Ihr Termin ist bestätigt.");
    expect(n).toBe(2);
  });

  it("liefert den Text auch dann, wenn das Duzen trotz Korrektur bleibt (nur Stil)", async () => {
    const stream = () => parts(text("Dein Termin ist bestätigt."));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe("Dein Termin ist bestätigt.");
  });

  it("entfernt Werkzeug-Erzaehlung aus der Antwort", async () => {
    const stream = () => parts(text("Ich rufe jetzt das Werkzeug zur Terminabsage auf. Ihr Termin wurde abgesagt."));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: [] });
    expect(out).toBe("Ihr Termin wurde abgesagt.");
  });

  it("lehnt 'vergeben' ab, wenn das Werkzeug die Zeit als FREI meldete (Fall Mittwoch 10 Uhr)", async () => {
    let n = 0;
    const freeResult: StreamPartLike = {
      type: "tool-result",
      toolName: "pruefe_verfuegbarkeit",
      output: { status: "ok", gewuenschte_zeit: { zeit: "10:00", frei: true } }
    };
    const stream = () =>
      ++n === 1
        ? parts(freeResult, text("10:00 Uhr ist leider schon vergeben."))
        : parts(freeResult, text("Mittwoch um 10:00 Uhr ist noch frei."));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe("Mittwoch um 10:00 Uhr ist noch frei.");
  });

  it("lehnt 'vergeben' ohne jede Pruefung ab und liefert nie die falsche Aussage", async () => {
    const stream = () => parts(text("10:00 Uhr ist leider schon vergeben."));
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe(UNBACKED_SENTENCE);
  });

  it("erlaubt 'vergeben', wenn das Werkzeug genau diese Zeit als nicht frei meldete", async () => {
    const stream = () =>
      parts(
        { type: "tool-result", toolName: "pruefe_verfuegbarkeit", output: { status: "ok", gewuenschte_zeit: { zeit: "10:00", frei: false } } },
        text("10:00 Uhr ist leider schon vergeben. Ich hätte 10:15 Uhr.")
      );
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe("10:00 Uhr ist leider schon vergeben. Ich hätte 10:15 Uhr.");
  });

  it("lehnt 'vergeben' fuer eine ANDERE Uhrzeit als die gemeldete ab", async () => {
    const stream = () =>
      parts(
        { type: "tool-result", toolName: "pruefe_verfuegbarkeit", output: { status: "ok", gewuenschte_zeit: { zeit: "10:30", frei: false } } },
        text("10:00 Uhr ist leider vergeben.")
      );
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe(UNBACKED_SENTENCE);
  });

  it("erlaubt 'nichts frei', wenn der Tag als ausgebucht gemeldet wurde", async () => {
    const stream = () =>
      parts(
        { type: "tool-result", toolName: "pruefe_verfuegbarkeit", output: { status: "keine_freien_slots" } },
        text("Am Montag ist leider nichts mehr frei.")
      );
    const out = await runTurnWithRepair({ providers: ["a"], stream, tools, messages: [], claimGuards: guards });
    expect(out).toBe("Am Montag ist leider nichts mehr frei.");
  });

  it("erzwingt beim Korrekturversuch einen Werkzeugaufruf (toolChoice required im ersten Schritt)", async () => {
    const seen: Array<unknown> = [];
    let n = 0;
    const stream = (_p: string, _m: unknown[], options?: { toolChoice?: unknown }) => {
      seen.push(options?.toolChoice);
      return ++n === 1
        ? parts(text("Ihr Termin wurde abgesagt."))
        : parts({ type: "tool-result", toolName: "termin_absagen", output: { status: "abgesagt" } }, text("Ihr Termin wurde abgesagt."));
    };
    const absagenTools = {
      termin_absagen: { inputSchema: z.object({ telefon: z.string() }), execute: async () => ({ status: "abgesagt" }) }
    } as never;
    const out = await runTurnWithRepair({
      providers: ["a"],
      stream,
      tools: absagenTools,
      messages: [],
      claimGuards: [{ pattern: /\b(abgesagt|storniert)\b/i, tools: ["termin_absagen"] }]
    });
    expect(out).toBe("Ihr Termin wurde abgesagt.");
    expect(seen).toEqual([undefined, "required"]);
  });

  describe("Wiederherstellung und Textsegmente", () => {
    const claim = [{ pattern: /\bgebucht\b/i, tools: ["termin_buchen"] }];

    it("setzt ein Leerzeichen zwischen Textsegmenten verschiedener Schritte", async () => {
      const stream = () =>
        parts({ type: "text-start" }, text("Ich pruefe das."), { type: "text-start" }, text("Ja, 10:00 Uhr ist frei."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [] });
      expect(out).toBe("Ich pruefe das. Ja, 10:00 Uhr ist frei.");
    });

    it("ruft die Wiederherstellung, wenn das Modell trotz Korrektur nur behauptet", async () => {
      const recover = vi.fn(async () => "Soll ich den Termin verbindlich buchen?");
      const stream = () => parts(text("Ihr Termin ist gebucht."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], claimGuards: claim, recover });
      expect(out).toBe("Soll ich den Termin verbindlich buchen?");
      expect(recover).toHaveBeenCalledTimes(1);
    });

    it("ruft die Wiederherstellung auch bei Fehlern aller Anbieter und leeren Antworten", async () => {
      const recover = vi.fn(async () => "Gerettet.");
      expect(await runTurnWithRepair({ providers: ["a", "b"], stream: () => parts({ type: "error", error: "x" }), tools: makeTools([]), messages: [], recover })).toBe("Gerettet.");
      expect(await runTurnWithRepair({ providers: ["a"], stream: () => parts(), tools: makeTools([]), messages: [], recover })).toBe("Gerettet.");
    });

    it("faellt auf den Ersatzsatz zurueck, wenn die Wiederherstellung nichts liefert oder scheitert", async () => {
      const none = await runTurnWithRepair({ providers: ["a"], stream: () => parts(), tools: makeTools([]), messages: [], recover: async () => null });
      expect(none).toBe(FALLBACK_SENTENCE);
      const boom = await runTurnWithRepair({ providers: ["a"], stream: () => parts(), tools: makeTools([]), messages: [], recover: async () => { throw new Error("x"); } });
      expect(boom).toBe(FALLBACK_SENTENCE);
    });

    it("fuehrt nichts doppelt aus: nach erfolgreicher Aktion ohne Text wird das Ergebnis wiedergegeben", async () => {
      const recover = vi.fn(async () => "darf nicht gerufen werden");
      const stream = () => parts({ type: "tool-result", toolName: "termin_buchen", output: { status: "gebucht", bestaetigung: "Mi 10:00" } });
      const out = await runTurnWithRepair({
        providers: ["a"],
        stream,
        tools: makeTools([]),
        messages: [],
        recover,
        renderResult: (tool, output) => (tool === "termin_buchen" ? `Gebucht: ${String(output.bestaetigung)}` : null)
      });
      expect(out).toBe("Gebucht: Mi 10:00");
      expect(recover).not.toHaveBeenCalled();
    });
  });

  describe("Absichts-Verwechslung und erweiterte Buchungsbehauptung", () => {
    const bookingGuard = [
      {
        pattern: /\b(gebucht|reserviert|eingetragen|vorgemerkt)\b|\btermin\b[^.!?]*\bbest[aä]tigt\b/i,
        unless: /\b(abgesagt|storniert|verschoben|umgebucht)\b/i,
        tools: ["termin_buchen"]
      }
    ];

    it("erkennt 'Termin ... bestätigt' ohne Buchungswerkzeug als unbelegt und rettet", async () => {
      const recover = vi.fn(async () => "Gerettet.");
      const stream = () => parts(text("Der Termin am Mittwoch um 10:00 Uhr ist bestätigt."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], claimGuards: bookingGuard, recover });
      expect(out).toBe("Gerettet.");
    });

    it("laesst Absage-Wortlaut trotz 'bestätigt' durch (unless)", async () => {
      const stream = () => parts({ type: "tool-result", toolName: "termin_absagen", output: { status: "abgesagt" } }, text("Ihre Absage ist bestätigt, der Termin wurde abgesagt."));
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], claimGuards: bookingGuard });
      expect(out).toBe("Ihre Absage ist bestätigt, der Termin wurde abgesagt.");
    });

    it("rettet sofort, wenn ein Werkzeug wegen verwechselter Aktion abgelehnt wurde", async () => {
      const recover = vi.fn(async () => "Ihr Termin wurde abgesagt.");
      const stream = vi.fn(() =>
        parts({ type: "tool-result", toolName: "termin_buchen", output: { status: "abgelehnt" } }, text("Der Termin ist leider bereits vergeben."))
      );
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], recover });
      expect(out).toBe("Ihr Termin wurde abgesagt.");
      expect(recover).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(1); // kein weiterer Modellversuch
    });

    it("rettet nicht, wenn nach der Ablehnung das richtige Werkzeug erfolgreich lief", async () => {
      const recover = vi.fn(async () => "darf nicht gerufen werden");
      const stream = () =>
        parts(
          { type: "tool-result", toolName: "termin_buchen", output: { status: "abgelehnt" } },
          { type: "tool-result", toolName: "termin_absagen", output: { status: "abgesagt" } },
          text("Ihr Termin wurde abgesagt.")
        );
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: makeTools([]), messages: [], recover });
      expect(out).toBe("Ihr Termin wurde abgesagt.");
      expect(recover).not.toHaveBeenCalled();
    });
  });

  describe("Fehler im erzwungenen Korrekturversuch", () => {
    it("wechselt dann NICHT den Anbieter, sondern rettet direkt", async () => {
      const seenProviders: string[] = [];
      let n = 0;
      const stream = (provider: string) => {
        seenProviders.push(provider);
        // Runde 1: Behauptung ohne Beleg; Runde 2 (erzwungen): Fehler wie ToolChoiceViolationError.
        return ++n === 1 ? parts(text("Ihr Termin ist gebucht.")) : parts({ type: "error", error: "ToolChoiceViolationError" });
      };
      const recover = vi.fn(async () => "Soll ich verbindlich buchen?");
      const out = await runTurnWithRepair({
        providers: ["lightllm", "workers-ai"],
        stream,
        tools: {
          termin_buchen: { inputSchema: z.object({ name: z.string() }), execute: async () => ({ status: "gebucht" }) }
        } as never,
        messages: [],
        claimGuards: [{ pattern: /\bgebucht\b/i, tools: ["termin_buchen"] }],
        recover
      });
      expect(out).toBe("Soll ich verbindlich buchen?");
      expect(seenProviders).toEqual(["lightllm", "lightllm"]); // workers-ai wurde nie gefragt
      expect(recover).toHaveBeenCalledTimes(1);
    });

    it("wechselt weiterhin den Anbieter, wenn der ERSTE Aufruf ausfaellt", async () => {
      const stream = (provider: string) =>
        provider === "lightllm" ? parts({ type: "error", error: "down" }) : parts(text("Antwort vom Rueckfall."));
      const out = await runTurnWithRepair({ providers: ["lightllm", "workers-ai"], stream, tools: makeTools([]), messages: [] });
      expect(out).toBe("Antwort vom Rueckfall.");
    });
  });

  describe("Korrekturversuch muss die behauptete Aktion wirklich belegen", () => {
    const buchTools = {
      termin_buchen: { inputSchema: z.object({ name: z.string() }), execute: async () => ({ status: "gebucht" }) }
    } as never;
    const guard = [{ pattern: /\bgebucht\b/i, tools: ["termin_buchen"] }];

    it("rettet, wenn der Korrekturversuch nur ein anderes Werkzeug nutzt und harmlos antwortet", async () => {
      let n = 0;
      const stream = () =>
        ++n === 1
          ? parts(text("Ihr Termin ist gebucht."))
          : parts({ type: "tool-result", toolName: "pruefe_verfuegbarkeit", output: { status: "ok" } }, text("Am Donnerstag um 11:00 Uhr ist frei."));
      const recover = vi.fn(async () => "Gebucht per Wiederherstellung.");
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools, messages: [], claimGuards: guard, recover });
      expect(out).toBe("Gebucht per Wiederherstellung.");
    });

    it("akzeptiert den Korrekturversuch, wenn die Aktion belegt ist", async () => {
      let n = 0;
      const stream = () =>
        ++n === 1
          ? parts(text("Ihr Termin ist gebucht."))
          : parts({ type: "tool-result", toolName: "termin_buchen", output: { status: "gebucht" } }, text("Ihr Termin ist jetzt gebucht."));
      const recover = vi.fn(async () => "darf nicht gerufen werden");
      const out = await runTurnWithRepair({ providers: ["a"], stream, tools: buchTools, messages: [], claimGuards: guard, recover });
      expect(out).toBe("Ihr Termin ist jetzt gebucht.");
      expect(recover).not.toHaveBeenCalled();
    });
  });
});
