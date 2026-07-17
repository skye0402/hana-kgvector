import { createHanaConnection } from "../src/hana/connection";
import {
  HanaNativeVectorStore,
  HanaNativeKnowledgeGraphStore,
  HanaNativeGraphRagIndex,
  createEntityNode,
  createRelation,
} from "../src";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

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

async function main() {
  const host = process.env.HANA_HOST;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (!host || !user || !password) {
    console.log("HANA credentials not set. Skipping native smoke test.");
    process.exit(0);
  }

  console.log("Connecting to HANA...");
  const conn = await createHanaConnection({ host, user, password });
  console.log("Connected to HANA.");

  const graphName = "URN_HKV_NATIVE_SMOKE_TEST";
  const vectorStore = new HanaNativeVectorStore(conn, { graphName, resetTables: true });
  const knowledgeGraphStore = new HanaNativeKnowledgeGraphStore(conn, { graphName, resetGraph: true });
  const index = new HanaNativeGraphRagIndex({ vectorStore, knowledgeGraphStore, embedModel });

  const report = createEntityNode({
    label: "REPORT",
    name: "ZSALES_REPORT",
    properties: { source_object: "ZSALES_REPORT" },
  });
  const table = createEntityNode({
    label: "TABLE",
    name: "MARA",
    properties: { source_object: "ZSALES_REPORT", auto_created: true },
  });
  const relation = createRelation({
    label: "READS_FROM",
    sourceId: report.id,
    targetId: table.id,
    properties: { source_object: "ZSALES_REPORT" },
  });

  const chunks = [
    {
      id: "native_smoke_chunk_1",
      text: "ABAP report ZSALES_REPORT reads material master data from table MARA.",
      metadata: {
        objectName: "ZSALES_REPORT",
        fileName: "zsales_report.abap",
        description: "Sales report",
        chunkIndex: 0,
        totalChunks: 1,
      },
    },
  ];

  const embeddings = await embedModel.getTextEmbeddingBatch(chunks.map((chunk) => chunk.text));
  await index.insertGraph({
    entities: [report, table],
    relations: [relation],
    chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] })),
  });

  const results = await index.query("Which report reads MARA?", {
    similarityTopK: 5,
    pathDepth: 2,
    limit: 10,
  });

  console.log(`Native smoke query returned ${results.length} results.`);
  for (const result of results.slice(0, 5)) {
    console.log(`[${result.score.toFixed(3)}] ${result.node.text}`);
  }

  const relationships = await index.getRelationships({ entityName: "ZSALES_REPORT", depth: 1 });
  console.log(`Native smoke relationship lookup returned ${relationships.length} relationships.`);

  if (!results.length || !relationships.some((r) => r.relation.label === "READS_FROM" && r.target.name === "MARA")) {
    throw new Error("Native smoke test did not retrieve expected graph context.");
  }

  conn.disconnect();
  console.log("Native smoke test complete.");
}

main().catch((err) => {
  console.error("Native smoke test failed:", err);
  process.exit(1);
});
