import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/lib/prompt";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt({ salonName: "Salon Test", nowMs: Date.UTC(2026, 9, 27, 10, 0, 0) });

  it("verlangt durchgehend die Anrede mit Sie", () => {
    expect(prompt).toContain('durchgehend mit "Sie" an');
    expect(prompt).toContain('niemals mit "du"');
  });

  it("nennt keine lockere Anrede als Vorbild", () => {
    expect(prompt).not.toMatch(/\blocker\b/i);
  });

  it("verbietet Werkzeug-Erzaehlung", () => {
    expect(prompt).toContain("Ich rufe jetzt das Werkzeug auf");
  });

  it("verlangt die Pruefung genau der genannten Uhrzeit", () => {
    expect(prompt).toContain("Parameter uhrzeit");
    expect(prompt).toContain("genau diese Zeit als nicht frei meldet");
  });
});
