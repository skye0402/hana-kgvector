import OpenAI from "openai";
import { loadEnv } from "../src/env";

loadEnv();

async function main() {
  const baseURL = process.env.LITELLM_PROXY_URL;
  const apiKey = process.env.LITELLM_API_KEY ?? "any-key";
  const model = process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini";

  if (!baseURL) {
    console.log("LITELLM_PROXY_URL is not set. Copy .env.example to .env.local and set it.");
    process.exit(0);
  }

  const client = new OpenAI({ apiKey, baseURL });

  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5
  });

  console.log("LiteLLM chat completion ok. Model:", model);
  console.log("Response id:", res.id);
  process.exit(0);
}

main().catch((err) => {
  console.error("LiteLLM validation failed:", err);
  process.exit(1);
});
