import type { SalonAgent } from "./agents/salon-agent";

export interface Env {
  AI: Ai;
  SALON_AGENT: DurableObjectNamespace<SalonAgent>;
  SALON_NAME: string;
  ADMIN_PASSWORD: string;
  AUDIO_BRIDGE_URL: string;
  AUDIO_BRIDGE_TOKEN: string;
  LIGHTLLM_BASE_URL: string;
  /** Modellname beim LiteLLM-Endpunkt (Standard siehe salon-agent.ts). */
  LIGHTLLM_MODEL?: string;
  /** Reihenfolge der Anbieter, z.B. "lightllm,workers-ai" (Standard: LiteLLM zuerst). */
  LLM_PROVIDER_ORDER?: string;
  /** Optional: Workers-AI-Modell (Standard siehe salon-agent.ts). */
  WORKERS_AI_MODEL?: string;
  LIGHTLLM_API_KEY: string;
}
