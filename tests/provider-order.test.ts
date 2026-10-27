import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ORDER, DEFAULT_STT_ORDER, describeProviderOrder, parseProviderOrder, parseSttOrder, resolveProviders } from "../src/lib/provider-order";

describe("parseProviderOrder", () => {
  it("liest die Reihenfolge aus der Konfiguration", () => {
    expect(parseProviderOrder("lightllm,workers-ai")).toEqual(["lightllm", "workers-ai"]);
    expect(parseProviderOrder("workers-ai, lightllm")).toEqual(["workers-ai", "lightllm"]);
    expect(parseProviderOrder("  LightLLM   workers-ai ")).toEqual(["lightllm", "workers-ai"]);
  });

  it("verwirft Unbekanntes und Doppeltes", () => {
    expect(parseProviderOrder("foo,lightllm,lightllm,bar")).toEqual(["lightllm"]);
  });

  it("nutzt LiteLLM zuerst, wenn nichts oder Unbrauchbares konfiguriert ist", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(["lightllm", "workers-ai"]);
    expect(parseProviderOrder(undefined)).toEqual(["lightllm", "workers-ai"]);
    expect(parseProviderOrder("")).toEqual(["lightllm", "workers-ai"]);
    expect(parseProviderOrder("nur-unsinn")).toEqual(["lightllm", "workers-ai"]);
  });

  it("erlaubt bewusst nur einen Anbieter (kein Rueckfall)", () => {
    expect(parseProviderOrder("lightllm")).toEqual(["lightllm"]);
  });
});

describe("resolveProviders", () => {
  const order = parseProviderOrder("lightllm,workers-ai");

  it("folgt bei auto der Konfiguration", () => {
    expect(resolveProviders("auto", order)).toEqual(["lightllm", "workers-ai"]);
  });

  it("der feste Admin-Anbieter gewinnt und hat keinen Rueckfall", () => {
    expect(resolveProviders("workers-ai", order)).toEqual(["workers-ai"]);
    expect(resolveProviders("lightllm", order)).toEqual(["lightllm"]);
  });

  it("veraendert die uebergebene Reihenfolge nicht", () => {
    const copy = [...order];
    resolveProviders("auto", order).reverse();
    expect(order).toEqual(copy);
  });
});

describe("describeProviderOrder", () => {
  it("beschreibt die wirksame Reihenfolge fuer das Startlog", () => {
    expect(describeProviderOrder("auto", ["lightllm", "workers-ai"])).toBe("auto -> lightllm -> workers-ai");
    expect(describeProviderOrder("workers-ai", ["lightllm", "workers-ai"])).toBe("fest: workers-ai (ohne Rueckfall)");
  });
});

describe("parseSttOrder", () => {
  it("liest die Reihenfolge, verwirft Unbekanntes und Doppeltes", () => {
    expect(parseSttOrder("whisper,workers-ai")).toEqual(["whisper", "workers-ai"]);
    expect(parseSttOrder("workers-ai whisper")).toEqual(["workers-ai", "whisper"]);
    expect(parseSttOrder("foo,whisper,whisper")).toEqual(["whisper"]);
  });

  it("nutzt Whisper zuerst, wenn nichts oder Unbrauchbares konfiguriert ist", () => {
    expect(DEFAULT_STT_ORDER).toEqual(["whisper", "workers-ai"]);
    expect(parseSttOrder(undefined)).toEqual(["whisper", "workers-ai"]);
    expect(parseSttOrder("lightllm")).toEqual(["whisper", "workers-ai"]);
  });
});
