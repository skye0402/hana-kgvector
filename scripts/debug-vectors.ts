/**
 * Debug script to test HANA vector operations
 */

import { createHanaConnection } from "../src/hana/connection";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY ?? "any-key",
  baseURL: process.env.LITELLM_PROXY_URL,
});

async function getEmbedding(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
    input: text,
    encoding_format: "base64",
  });
  return res.data[0].embedding;
}

async function main() {
  const host = process.env.HANA_HOST;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (!host || !user || !password) {
    console.error("HANA credentials not set");
    process.exit(1);
  }

  const conn = await createHanaConnection({ host, user, password });
  console.log("Connected to HANA");

  const exec = <T>(sql: string, params?: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      (conn as any).exec(sql, params ?? [], (err: unknown, result: unknown) =>
        err ? reject(err) : resolve(result as T)
      );
    });

  // Check vector table contents
  console.log("\n--- Vector Table Contents ---");
  const vectorRows = await exec<any[]>(`SELECT id, label, name, LENGTH(TO_NVARCHAR(embedding)) as emb_len FROM URN_HKV_QUALITY_TEST_VECTORS LIMIT 10`);
  console.log("Rows:", vectorRows.length);
  for (const row of vectorRows) {
    console.log(`  ${row.ID || row.id}: ${row.LABEL || row.label} - ${row.NAME || row.name} (emb_len: ${row.EMB_LEN || row.emb_len})`);
  }

  // Get a query embedding
  console.log("\n--- Testing Vector Query ---");
  const queryText = "Apple CEO";
  const queryEmb = await getEmbedding(queryText);
  console.log(`Query: "${queryText}" (embedding dim: ${queryEmb.length})`);
  
  // Check if embedding has actual values
  const nonZeroCount = queryEmb.filter(v => v !== 0).length;
  const sum = queryEmb.reduce((a, b) => a + b, 0);
  console.log(`Non-zero values: ${nonZeroCount}/${queryEmb.length}, Sum: ${sum}`);
  console.log(`First 10 values: [${queryEmb.slice(0, 10).map(v => v.toFixed(6)).join(", ")}]`);
  
  // Check stored embedding values
  console.log("\n--- Checking Stored Embedding Values ---");
  const storedEmb = await exec<any[]>(`
    SELECT TOP 1 id, name, embedding 
    FROM URN_HKV_QUALITY_TEST_VECTORS 
    WHERE embedding IS NOT NULL
  `);
  if (storedEmb.length > 0) {
    const row = storedEmb[0];
    console.log(`Stored for: ${row.NAME || row.name}`);
    const embBuffer = row.EMBEDDING || row.embedding;
    console.log(`Embedding type: ${typeof embBuffer}, isBuffer: ${Buffer.isBuffer(embBuffer)}`);
    if (Buffer.isBuffer(embBuffer)) {
      // REAL_VECTOR is stored as binary - 4 bytes per float32
      const floats: number[] = [];
      for (let i = 0; i < Math.min(40, embBuffer.length); i += 4) {
        floats.push(embBuffer.readFloatLE(i));
      }
      console.log(`First 10 stored floats: [${floats.slice(0, 10).map(v => v.toFixed(6)).join(", ")}]`);
    }
  }

  // Test different vector formats for COSINE_SIMILARITY
  const formats = [
    { name: "JSON array", value: JSON.stringify(queryEmb) },
    { name: "Bracketed list", value: `[${queryEmb.join(",")}]` },
    { name: "Plain list", value: queryEmb.join(",") },
  ];

  for (const fmt of formats) {
    console.log(`\nTesting format: ${fmt.name}`);
    try {
      const similarityResult = await exec<any[]>(`
        SELECT TOP 5 id, label, name, 
          COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS score
        FROM URN_HKV_QUALITY_TEST_VECTORS
        WHERE embedding IS NOT NULL
        ORDER BY score DESC
      `, [fmt.value]);

      for (const row of similarityResult) {
        const score = row.SCORE ?? row.score;
        console.log(`  [${score?.toFixed(4) ?? 'NULL'}] ${row.LABEL || row.label}: ${row.NAME || row.name}`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
  }

  // Try with explicit vector literal
  console.log("\nTesting with inline vector literal (first 5 dims):");
  const shortVec = queryEmb.slice(0, 5);
  try {
    const inlineResult = await exec<any[]>(`
      SELECT TO_REAL_VECTOR('[${shortVec.join(",")}]') AS vec FROM DUMMY
    `);
    console.log("  Inline vector works:", inlineResult);
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // Check if embeddings have the right dimension
  console.log("\n--- Checking Embedding Dimensions ---");
  const dimCheck = await exec<any[]>(`
    SELECT id, CARDINALITY(embedding) as dim 
    FROM URN_HKV_QUALITY_TEST_VECTORS 
    WHERE embedding IS NOT NULL 
    LIMIT 5
  `);
  for (const row of dimCheck) {
    console.log(`  ${row.ID || row.id}: dim=${row.DIM || row.dim}`);
  }

  conn.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
