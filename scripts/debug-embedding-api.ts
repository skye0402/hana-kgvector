/**
 * Debug script to test embedding API directly
 */

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  console.log("=== Embedding API Debug ===\n");
  console.log("Config:");
  console.log(`  LITELLM_PROXY_URL: ${process.env.LITELLM_PROXY_URL}`);
  console.log(`  DEFAULT_EMBEDDING_MODEL: ${process.env.DEFAULT_EMBEDDING_MODEL}`);
  console.log(`  API Key (masked): ${process.env.LITELLM_API_KEY?.slice(0, 8)}...`);

  const openai = new OpenAI({
    apiKey: process.env.LITELLM_API_KEY ?? "any-key",
    baseURL: process.env.LITELLM_PROXY_URL,
  });

  const testText = "Apple Inc. is a technology company";
  console.log(`\nTest text: "${testText}"`);

  try {
    const model = process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small";
    console.log(`\nCalling embeddings API with model: ${model}`);
    
    const response = await openai.embeddings.create({
      model,
      input: testText,
      encoding_format: "base64"
    });

    console.log("\nRaw API response structure:");
    console.log(`  model: ${response.model}`);
    console.log(`  usage: ${JSON.stringify(response.usage)}`);
    console.log(`  data length: ${response.data.length}`);
    
    if (response.data.length > 0) {
      const embedding = response.data[0].embedding;
      console.log(`\nEmbedding details:`);
      console.log(`  Type: ${typeof embedding}`);
      console.log(`  Is Array: ${Array.isArray(embedding)}`);
      console.log(`  Length: ${embedding.length}`);
      
      const nonZeroCount = embedding.filter(v => v !== 0).length;
      const sum = embedding.reduce((a, b) => a + b, 0);
      const minVal = Math.min(...embedding);
      const maxVal = Math.max(...embedding);
      
      console.log(`  Non-zero values: ${nonZeroCount}/${embedding.length}`);
      console.log(`  Sum: ${sum}`);
      console.log(`  Min: ${minVal}, Max: ${maxVal}`);
      console.log(`  First 10: [${embedding.slice(0, 10).map(v => v.toFixed(6)).join(", ")}]`);
      
      if (nonZeroCount === 0) {
        console.log("\n⚠️  WARNING: Embedding is all zeros! Check your embedding model configuration.");
      } else {
        console.log("\n✅ Embedding has non-zero values - API is working correctly.");
      }
    }
  } catch (err: any) {
    console.error("\nAPI Error:", err.message);
    if (err.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
  }
}

main().catch(console.error);
