import { describe, expect, it } from "vitest";
import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";
import { chainTranscribers } from "../src/lib/stt-chain";

function fake(name: string, opts: { readyError?: string; log: string[] }): Transcriber {
  return {
    createSession(options?: TranscriberSessionOptions): TranscriberSession {
      opts.log.push(`${name}:session`);
      return {
        feed() {
          opts.log.push(`${name}:feed`);
        },
        async waitUntilReady() {
          if (opts.readyError) throw new Error(opts.readyError);
        },
        close() {}
      };
    }
  };
}

describe("chainTranscribers", () => {
  it("nutzt den ersten Anbieter, solange er bereit ist (Fallbacks werden nicht einmal erzeugt)", async () => {
    const log: string[] = [];
    let created = 0;
    const t = chainTranscribers([
      () => fake("whisper", { log }),
      () => {
        created++;
        return fake("flux", { log });
      }
    ]);
    const s = t.createSession({});
    await s.waitUntilReady?.();
    s.feed(new ArrayBuffer(4));
    expect(log).toEqual(["whisper:session", "whisper:feed"]);
    expect(created).toBe(0);
  });

  it("wechselt bei nicht bereitem Primaeranbieter auf den naechsten und spielt gepuffertes Audio nach", async () => {
    const log: string[] = [];
    const t = chainTranscribers([
      () => fake("whisper", { log, readyError: "STT-Dienst nicht bereit" }),
      () => fake("flux", { log })
    ]);
    const s = t.createSession({});
    s.feed(new ArrayBuffer(4));
    await s.waitUntilReady?.();
    expect(log).toContain("flux:session");
    expect(log).toContain("flux:feed");
    s.feed(new ArrayBuffer(4));
    expect(log.filter((l) => l === "flux:feed").length).toBeGreaterThanOrEqual(2);
  });

  it("verkettet drei Stufen (whisper -> flux -> kanal)", async () => {
    const log: string[] = [];
    const t = chainTranscribers([
      () => fake("whisper", { log, readyError: "down" }),
      () => fake("flux", { log, readyError: "quota" }),
      () => fake("kanal", { log })
    ]);
    const s = t.createSession({});
    await s.waitUntilReady?.();
    s.feed(new ArrayBuffer(4));
    expect(log).toContain("kanal:session");
    expect(log).toContain("kanal:feed");
  });

  it("lehnt eine leere Kette ab", () => {
    expect(() => chainTranscribers([])).toThrow();
  });
});
