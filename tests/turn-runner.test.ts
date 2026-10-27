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
