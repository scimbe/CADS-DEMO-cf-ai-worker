import { describe, expect, it } from "vitest";
import { extractLeakedToolCalls } from "../src/lib/leaked-tool-calls";

const TOOLS = ["pruefe_verfuegbarkeit", "termin_buchen", "termine_suchen"];

describe("extractLeakedToolCalls", () => {
  it("erkennt den Produktionsfall (Text + type:function-JSON am Ende)", () => {
    const input =
      'Sobald ich diese Informationen habe, kann ich den Termin buchen. {"type": "function", "name": "pruefe_verfuegbarkeit", "parameters": {"datum": "2026-10-28", "leistung": "schneiden_kurz"}}';
    const r = extractLeakedToolCalls(input, TOOLS);
    expect(r.calls).toEqual([
      { name: "pruefe_verfuegbarkeit", args: { datum: "2026-10-28", leistung: "schneiden_kurz" } }
    ]);
    expect(r.text).toBe("Sobald ich diese Informationen habe, kann ich den Termin buchen.");
    expect(r.text).not.toContain("{");
  });

  it("erkennt reinen JSON-Text ohne weiteren Inhalt", () => {
    const r = extractLeakedToolCalls('{"name":"termine_suchen","parameters":{"telefon":"0151"}}', TOOLS);
    expect(r.calls).toEqual([{ name: "termine_suchen", args: { telefon: "0151" } }]);
    expect(r.text).toBe("");
  });

  it("unterstuetzt OpenAI-Form mit arguments als JSON-String", () => {
    const r = extractLeakedToolCalls(
      '{"type":"function","function":{"name":"termine_suchen","arguments":"{\\"telefon\\":\\"0151\\"}"}}',
      TOOLS
    );
    expect(r.calls).toEqual([{ name: "termine_suchen", args: { telefon: "0151" } }]);
  });

  it("entfernt <tool_call>- und Code-Fence-Huellen", () => {
    const a = extractLeakedToolCalls('Moment. <tool_call>{"name":"termine_suchen","arguments":{"telefon":"1"}}</tool_call>', TOOLS);
    expect(a.text).toBe("Moment.");
    expect(a.calls).toHaveLength(1);
    const b = extractLeakedToolCalls('Ich pruefe das.\n```json\n{"name":"termine_suchen","arguments":{"telefon":"1"}}\n```', TOOLS);
    expect(b.text).toBe("Ich pruefe das.");
    expect(b.calls).toHaveLength(1);
  });

  it("erkennt mehrere Aufrufe, auch als Array", () => {
    const r = extractLeakedToolCalls(
      '[{"name":"termine_suchen","parameters":{"telefon":"1"}},{"name":"pruefe_verfuegbarkeit","parameters":{"datum":"2026-10-28","leistung":"schneiden_kurz"}}]',
      TOOLS
    );
    expect(r.calls.map((c) => c.name)).toEqual(["termine_suchen", "pruefe_verfuegbarkeit"]);
    expect(r.text).toBe("");
  });

  it("blendet Aufrufe unbekannter Werkzeuge aus, fuehrt sie aber nicht aus", () => {
    const r = extractLeakedToolCalls('Okay. {"type":"function","name":"rm_rf","parameters":{}}', TOOLS);
    expect(r.calls).toEqual([]);
    expect(r.text).toBe("Okay.");
  });

  it("blendet ein abgeschnittenes Aufruf-Fragment aus", () => {
    const r = extractLeakedToolCalls('Einen Moment. {"type": "function", "name": "pruefe_verfuegbarkeit", "param', TOOLS);
    expect(r.calls).toEqual([]);
    expect(r.text).toBe("Einen Moment.");
  });

  it("laesst normalen Text und harmlose Klammern unveraendert", () => {
    const t = "Wir haben Dienstag um 14 Uhr frei {gern} und [auch] Mittwoch.";
    expect(extractLeakedToolCalls(t, TOOLS)).toEqual({ text: t, calls: [] });
  });

  it("haelt JSON ohne Aufruf-Merkmale fuer normalen Text", () => {
    const t = 'Hier: {"name":"Anna"}';
    expect(extractLeakedToolCalls(t, TOOLS)).toEqual({ text: t, calls: [] });
  });

  it("kommt mit Klammern und Anfuehrungszeichen in Strings zurecht", () => {
    const r = extractLeakedToolCalls('{"name":"termine_suchen","parameters":{"telefon":"a}\\"{b"}} Fertig.', TOOLS);
    expect(r.calls[0].args).toEqual({ telefon: 'a}"{b' });
    expect(r.text).toBe("Fertig.");
  });
});
