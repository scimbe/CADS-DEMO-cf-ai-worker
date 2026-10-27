import type { SalonAgent } from "./agents/salon-agent";

export interface Env {
  AI: Ai;
  SALON_AGENT: DurableObjectNamespace<SalonAgent>;
  SALON_NAME: string;
  ADMIN_PASSWORD: string;
  AUDIO_BRIDGE_URL: string;
  AUDIO_BRIDGE_TOKEN: string;
  LIGHTLLM_BASE_URL: string;
  LIGHTLLM_API_KEY: string;
}
