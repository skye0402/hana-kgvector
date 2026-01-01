import { loadEnv } from "../src/env";
import { createHanaConnection } from "../src/hana/connection";
import {
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
  createEntityNode,
  createRelation,
} from "../src/graph";
import OpenAI from "openai";

loadEnv();

const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY ?? "any-key",
  baseURL: process.env.LITELLM_PROXY_URL,
});

const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
    const res = await openai.embeddings.create({
      model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
      input: text,
      encoding_format: "base64",
    });
    return res.data[0].embedding;
  },
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await openai.embeddings.create({
      model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
      input: texts,
      encoding_format: "base64",
    });
    return res.data.map((d) => d.embedding);
  },
};

const llmClient = {
  async structuredPredict<T>(schema: any, prompt: string): Promise<T> {
    const res = await openai.chat.completions.create({
      model: process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const content = res.choices[0]?.message?.content ?? "{}";
    return JSON.parse(content) as T;
  },
};

async function main() {
  console.log("Connecting to HANA...");

  const host = process.env.HANA_HOST;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (!host || !user || !password) {
    console.log("HANA credentials not set. Skipping smoke test.");
    process.exit(0);
  }

  console.log("Embedding model: ", process.env.DEFAULT_EMBEDDING_MODEL);
  console.log("LLM model: ", process.env.DEFAULT_LLM_MODEL);
  
  const conn = await createHanaConnection({ host, user, password });
  console.log("Connected to HANA.");

  // Detect embedding dimension dynamically to align with HANA REAL_VECTOR column
  const probe = await embedModel.getTextEmbedding("dimension-probe");
  const vectorDimension = probe.length;
  console.log(`Embedding dimension: ${vectorDimension}`);

  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: "urn:hkv:smoke_test",
    vectorTableName: "URN_HKV_SMOKE_TEST_VECTORS",
    llamaNodesTableName: "URN_HKV_SMOKE_TEST_NODES",
    resetTables: true,
  });

  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema: {
          entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT"],
          relationTypes: ["WORKS_AT", "LOCATED_IN", "PRODUCES", "KNOWS"],
          validationSchema: [
            ["PERSON", "WORKS_AT", "ORGANIZATION"],
            ["PERSON", "KNOWS", "PERSON"],
            ["ORGANIZATION", "LOCATED_IN", "LOCATION"],
            ["ORGANIZATION", "PRODUCES", "PRODUCT"],
          ],
        },
        maxTripletsPerChunk: 5,
      }),
      new ImplicitPathExtractor(),
    ],
    embedKgNodes: true,
    showProgress: true,
  });

  for (let i = 1; i <= 3; i++) {
    console.log(`Run ${i}/3: inserting sample documents...`);

    await index.insert([
      {
        id: `doc_1_run_${i}`,
        text: "Alice works at SAP in Walldorf. She knows Bob who also works at SAP. SAP produces enterprise software.",
        metadata: { documentId: `sample_doc_${i}` },
      },
      {
        id: `doc_2_run_${i}`,
        text: "Bob is a software engineer at SAP. He collaborates with Carol from Microsoft in Seattle.",
        metadata: { documentId: `sample_doc_${i}` },
      },
    ]);

    console.log(`Run ${i}/3: querying the graph...`);
    const results = await index.query("Who works at SAP?");
    console.log(`Run ${i}/3: found ${results.length} results`);
  }

  console.log("Documents inserted.");

  console.log("Smoke test complete.");
  conn.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
