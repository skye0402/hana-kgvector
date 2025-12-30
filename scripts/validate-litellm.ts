import OpenAI from "openai";
import { loadEnv } from "../src/env";

loadEnv();

function safeFail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const baseURL = process.env.LITELLM_PROXY_URL;
  const apiKey = process.env.LITELLM_API_KEY ?? "any-key";
  const model = process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini";

  if (!baseURL) {
    console.log("LITELLM_PROXY_URL is not set. Copy .env.example to .env.local and set it.");
    process.exit(0);
  }

  const client = new OpenAI({ apiKey, baseURL });

  let res: OpenAI.Chat.Completions.ChatCompletion;
  try {
    res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5
    });
  } catch {
    safeFail(
      "LiteLLM validation failed. Check: (1) proxy URL is reachable, (2) API key is valid, (3) model name is deployed/allowed on the proxy."
    );
  }

  console.log("LiteLLM chat completion ok. Model:", model);
  console.log("Response id:", res.id);
  process.exit(0);
}

main().catch((err) => {
  // Avoid dumping raw error objects which may contain sensitive info.
  console.error("LiteLLM validation failed (unexpected error). Check proxy URL/model/key.");
  process.exit(1);
});
