import { routeAgentRequest } from "agents";
import type { Env } from "./env";

export { SalonAgent } from "./agents/salon-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env, { cors: true });
    if (agentResponse) return agentResponse;
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
