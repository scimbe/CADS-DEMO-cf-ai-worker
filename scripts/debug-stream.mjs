import { createWorkersAI } from "workers-ai-provider";
import { streamText, stepCountIs } from "ai";

const accountId = process.env.CF_ACCOUNT_ID;
const apiKey = process.env.CF_API_TOKEN;

const workersai = createWorkersAI({ accountId, apiKey });

const result = streamText({
  model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  system: "Du bist eine freundliche Empfangskraft. Antworte kurz auf Deutsch.",
  messages: [{ role: "user", content: "Hallo, welche Leistungen bieten Sie an?" }],
  stopWhen: stepCountIs(5)
});

let i = 0;
let joined = "";
for await (const part of result.stream) {
  i++;
  if (part.type === "text-delta") {
    joined += part.text;
    console.log(i, JSON.stringify(part.type), JSON.stringify(part.text));
  } else {
    console.log(i, JSON.stringify(part.type));
  }
}
console.log("---JOINED---");
console.log(joined);
