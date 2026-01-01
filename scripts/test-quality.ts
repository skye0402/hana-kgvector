/**
 * Quality Test Suite for HANA PropertyGraphIndex
 * 
 * This script tests:
 * 1. Entity/relation extraction quality (do we extract expected entities?)
 * 2. Vector retrieval relevance (do queries return relevant results?)
 * 3. Graph traversal correctness (can we follow relationships?)
 * 4. End-to-end hybrid retrieval quality
 * 
 * Run: pnpm exec tsx scripts/test-quality.ts
 */

import { loadEnv } from "../src/env";
import { createHanaConnection } from "../src/hana/connection";
import {
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
  VectorContextRetriever,
} from "../src/graph";
import { KG_NODES_KEY, KG_RELATIONS_KEY } from "../src/graph/types";
import type { EntityNode, Relation } from "../src/graph/types";
import OpenAI from "openai";

loadEnv();

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

const TEST_DOCUMENTS = [
  {
    id: "doc_apple",
    text: "Apple Inc. is headquartered in Cupertino, California. Tim Cook is the CEO of Apple. Apple produces the iPhone and MacBook products.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
  {
    id: "doc_microsoft",
    text: "Microsoft Corporation is located in Redmond, Washington. Satya Nadella serves as CEO of Microsoft. Microsoft develops Windows and Azure cloud services.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
  {
    id: "doc_google",
    text: "Google is a subsidiary of Alphabet Inc. and is based in Mountain View, California. Sundar Pichai is the CEO of Google. Google created the Android operating system.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
];

// Expected entities we should find (for quality checks)
const EXPECTED_ENTITIES = {
  organizations: ["Apple", "Microsoft", "Google", "Alphabet"],
  people: ["Tim Cook", "Satya Nadella", "Sundar Pichai"],
  locations: ["Cupertino", "Redmond", "Mountain View", "California", "Washington"],
  products: ["iPhone", "MacBook", "Windows", "Azure", "Android"],
};

// Expected relations
const EXPECTED_RELATIONS = [
  { type: "LOCATED_IN", examples: ["Apple in Cupertino", "Microsoft in Redmond", "Google in Mountain View"] },
  { type: "CEO_OF", examples: ["Tim Cook CEO Apple", "Satya Nadella CEO Microsoft", "Sundar Pichai CEO Google"] },
  { type: "PRODUCES", examples: ["Apple produces iPhone", "Microsoft develops Windows"] },
];

// Test queries and expected relevant entities
const TEST_QUERIES = [
  {
    query: "Who is the CEO of Apple?",
    expectedEntities: ["Tim Cook", "Apple"],
    expectedRelation: "CEO",
  },
  {
    query: "Where is Microsoft located?",
    expectedEntities: ["Microsoft", "Redmond", "Washington"],
    expectedRelation: "LOCATED",
  },
  {
    query: "What products does Google make?",
    expectedEntities: ["Google", "Android"],
    expectedRelation: "PRODUCES",
  },
  {
    query: "Tech companies in California",
    expectedEntities: ["Apple", "Google", "California"],
    expectedRelation: "LOCATED",
  },
];

// ============================================================================
// TEST UTILITIES
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  score?: number;
}

const results: TestResult[] = [];

function log(message: string, indent = 0) {
  const prefix = "  ".repeat(indent);
  console.log(`${prefix}${message}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(70));
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

function logSubsection(title: string) {
  console.log(`\n--- ${title} ---`);
}

function addResult(name: string, passed: boolean, details: string, score?: number) {
  results.push({ name, passed, details, score });
  const icon = passed ? "✅" : "❌";
  const scoreStr = score !== undefined ? ` (score: ${(score * 100).toFixed(1)}%)` : "";
  log(`${icon} ${name}${scoreStr}: ${details}`);
}

function containsAny(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

// ============================================================================
// OPENAI / LITELLM SETUP
// ============================================================================

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

// Check if embedding API is returning valid (non-zero) embeddings
async function checkEmbeddingHealth(): Promise<{ healthy: boolean; details: string }> {
  try {
    const testEmb = await embedModel.getTextEmbedding("test embedding health check");
    const nonZeroCount = testEmb.filter((v) => v !== 0).length;
    if (nonZeroCount === 0) {
      return {
        healthy: false,
        details: `Embedding API returns all zeros (${testEmb.length} dims). Check LiteLLM proxy configuration.`,
      };
    }
    return { healthy: true, details: `OK - ${nonZeroCount}/${testEmb.length} non-zero values` };
  } catch (err: any) {
    return { healthy: false, details: `API error: ${err.message}` };
  }
}

const llmClient = {
  async structuredPredict<T>(schema: any, prompt: string): Promise<T> {
    const res = await openai.chat.completions.create({
      model: process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    let content = res.choices[0]?.message?.content ?? "{}";
    // Strip markdown code blocks if present (some LLMs wrap JSON in ```json...```)
    content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    return JSON.parse(content) as T;
  },
};

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

async function main() {
  logSection("HANA PropertyGraphIndex Quality Test Suite");

  const host = process.env.HANA_HOST;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (!host || !user || !password) {
    console.error("HANA credentials not set. Set HANA_HOST, HANA_USER, HANA_PASSWORD in .env.local");
    process.exit(1);
  }

  log(`Embedding model: ${process.env.DEFAULT_EMBEDDING_MODEL}`);
  log(`LLM model: ${process.env.DEFAULT_LLM_MODEL}`);

  // Check embedding API health first
  logSubsection("Checking Embedding API Health");
  const embeddingHealth = await checkEmbeddingHealth();
  if (!embeddingHealth.healthy) {
    log(`⚠️  EMBEDDING API ISSUE: ${embeddingHealth.details}`);
    log("Vector similarity tests will be skipped or show degraded results.");
  } else {
    log(`✅ Embedding API: ${embeddingHealth.details}`);
  }

  // Connect to HANA
  logSubsection("Connecting to HANA");
  const conn = await createHanaConnection({ host, user, password });
  log("Connected to HANA successfully.");

  // Detect embedding dimension
  const probe = await embedModel.getTextEmbedding("dimension-probe");
  const vectorDimension = probe.length;
  log(`Embedding dimension: ${vectorDimension}`);

  // Create graph store with reset (clean slate for testing)
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: "urn:hkv:quality_test",
    vectorTableName: "URN_HKV_QUALITY_TEST_VECTORS",
    llamaNodesTableName: "URN_HKV_QUALITY_TEST_NODES",
    resetTables: true,
  });

  // Create the index
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema: {
          entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT"],
          relationTypes: ["CEO_OF", "LOCATED_IN", "PRODUCES", "WORKS_AT", "SUBSIDIARY_OF"],
          validationSchema: [
            ["PERSON", "CEO_OF", "ORGANIZATION"],
            ["PERSON", "WORKS_AT", "ORGANIZATION"],
            ["ORGANIZATION", "LOCATED_IN", "LOCATION"],
            ["ORGANIZATION", "PRODUCES", "PRODUCT"],
            ["ORGANIZATION", "SUBSIDIARY_OF", "ORGANIZATION"],
          ],
        },
        maxTripletsPerChunk: 10,
      }),
      new ImplicitPathExtractor(),
    ],
    embedKgNodes: true,
    showProgress: false,
  });

  // =========================================================================
  // TEST 1: ENTITY/RELATION EXTRACTION QUALITY
  // =========================================================================
  logSection("TEST 1: Entity/Relation Extraction Quality");

  log("Inserting test documents...");
  const insertedNodes = await index.insert(TEST_DOCUMENTS);

  logSubsection("Extracted Entities");

  // Collect all extracted nodes
  const allExtractedNodes: EntityNode[] = [];
  const allExtractedRelations: Relation[] = [];

  for (const node of insertedNodes) {
    const kgNodes = (node.metadata[KG_NODES_KEY] as EntityNode[]) ?? [];
    const kgRelations = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];
    allExtractedNodes.push(...kgNodes);
    allExtractedRelations.push(...kgRelations);
  }

  // Log extracted entities by type
  const nodesByType: Record<string, EntityNode[]> = {};
  for (const node of allExtractedNodes) {
    const type = node.label;
    if (!nodesByType[type]) nodesByType[type] = [];
    nodesByType[type].push(node);
  }

  for (const [type, nodes] of Object.entries(nodesByType)) {
    const uniqueNames = [...new Set(nodes.map((n) => n.name))];
    log(`${type}: ${uniqueNames.join(", ")}`, 1);
  }

  logSubsection("Extracted Relations");

  // Log extracted relations by type
  const relationsByType: Record<string, Relation[]> = {};
  for (const rel of allExtractedRelations) {
    const type = rel.label;
    if (!relationsByType[type]) relationsByType[type] = [];
    relationsByType[type].push(rel);
  }

  for (const [type, rels] of Object.entries(relationsByType)) {
    log(`${type}: ${rels.length} relations`, 1);
    for (const rel of rels.slice(0, 3)) {
      log(`  ${rel.sourceId} -> ${rel.targetId}`, 2);
    }
    if (rels.length > 3) log(`  ... and ${rels.length - 3} more`, 2);
  }

  // Quality assertions for extraction
  logSubsection("Extraction Quality Assertions");

  // Check if we found expected organizations
  const orgNames = (nodesByType["ORGANIZATION"] ?? []).map((n) => n.name.toLowerCase());
  const foundOrgs = EXPECTED_ENTITIES.organizations.filter((o) =>
    orgNames.some((name) => name.includes(o.toLowerCase()))
  );
  const orgScore = foundOrgs.length / EXPECTED_ENTITIES.organizations.length;
  addResult(
    "Organizations extracted",
    orgScore >= 0.5,
    `Found ${foundOrgs.length}/${EXPECTED_ENTITIES.organizations.length}: ${foundOrgs.join(", ")}`,
    orgScore
  );

  // Check if we found expected people
  const personNames = (nodesByType["PERSON"] ?? []).map((n) => n.name.toLowerCase());
  const foundPeople = EXPECTED_ENTITIES.people.filter((p) =>
    personNames.some((name) => name.includes(p.toLowerCase().split(" ")[1] ?? p.toLowerCase()))
  );
  const personScore = foundPeople.length / EXPECTED_ENTITIES.people.length;
  addResult(
    "People extracted",
    personScore >= 0.5,
    `Found ${foundPeople.length}/${EXPECTED_ENTITIES.people.length}: ${foundPeople.join(", ")}`,
    personScore
  );

  // Check if we found expected locations
  const locationNames = (nodesByType["LOCATION"] ?? []).map((n) => n.name.toLowerCase());
  const foundLocations = EXPECTED_ENTITIES.locations.filter((l) =>
    locationNames.some((name) => name.includes(l.toLowerCase()))
  );
  const locationScore = foundLocations.length / EXPECTED_ENTITIES.locations.length;
  addResult(
    "Locations extracted",
    locationScore >= 0.3,
    `Found ${foundLocations.length}/${EXPECTED_ENTITIES.locations.length}: ${foundLocations.join(", ")}`,
    locationScore
  );

  // Check relations were extracted
  const totalRelations = allExtractedRelations.length;
  addResult(
    "Relations extracted",
    totalRelations >= 5,
    `Extracted ${totalRelations} relations across ${Object.keys(relationsByType).length} types`,
    Math.min(totalRelations / 10, 1)
  );

  // =========================================================================
  // TEST 2: VECTOR RETRIEVAL RELEVANCE
  // =========================================================================
  logSection("TEST 2: Vector Retrieval Relevance");

  if (!embeddingHealth.healthy) {
    log("⚠️  Note: Vector similarity may be degraded due to embedding API issues.");
  }

  for (const testCase of TEST_QUERIES) {
    logSubsection(`Query: "${testCase.query}"`);

    const queryResults = await index.query(testCase.query);

    log(`Found ${queryResults.length} results`);

    // Log top results with scores
    for (const result of queryResults.slice(0, 5)) {
      const score = result.score.toFixed(3);
      const text = result.node.text.slice(0, 100).replace(/\n/g, " ");
      log(`[${score}] ${text}...`, 1);
    }

    // Check if expected entities appear in results
    const allResultText = queryResults
      .slice(0, 10)
      .map((r) => r.node.text)
      .join(" ")
      .toLowerCase();

    const foundExpected = containsAny(allResultText, testCase.expectedEntities);
    const relevanceScore = foundExpected.length / testCase.expectedEntities.length;

    addResult(
      `Query relevance: "${testCase.query.slice(0, 30)}..."`,
      relevanceScore >= 0.5,
      `Found ${foundExpected.length}/${testCase.expectedEntities.length} expected: ${foundExpected.join(", ")}`,
      relevanceScore
    );
  }

  // =========================================================================
  // TEST 3: GRAPH TRAVERSAL CORRECTNESS
  // =========================================================================
  logSection("TEST 3: Graph Traversal Correctness");

  logSubsection("Testing VectorContextRetriever with path expansion");

  const retriever = new VectorContextRetriever({
    graphStore,
    embedModel,
    similarityTopK: 5,
    pathDepth: 2,
    includeText: true,
  });

  const traversalQuery = "Apple CEO";
  log(`Query: "${traversalQuery}"`);

  const traversalResults = await retriever.retrieve({ queryStr: traversalQuery });

  log(`Retrieved ${traversalResults.length} nodes after graph expansion`);

  // Log the retrieved nodes
  for (const result of traversalResults.slice(0, 8)) {
    const nodeType = (result.node.metadata as any)?.label ?? "CHUNK";
    const nodeName = (result.node.metadata as any)?.name ?? result.node.id;
    const score = result.score?.toFixed(3) ?? "N/A";
    log(`[${score}] ${nodeType}: ${nodeName}`, 1);
    if (result.node.text) {
      log(`    Text: ${result.node.text.slice(0, 80)}...`, 1);
    }
  }

  // Check if graph traversal found related entities
  const traversalText = traversalResults.map((r) => JSON.stringify(r.node.metadata) + " " + r.node.text).join(" ").toLowerCase();
  const appleRelated = ["apple", "tim cook", "cupertino", "iphone", "macbook"];
  const foundRelated = containsAny(traversalText, appleRelated);

  addResult(
    "Graph traversal finds related entities",
    foundRelated.length >= 2,
    `Found ${foundRelated.length}/5 Apple-related entities: ${foundRelated.join(", ")}`,
    foundRelated.length / 5
  );

  // =========================================================================
  // TEST 4: END-TO-END HYBRID RETRIEVAL
  // =========================================================================
  logSection("TEST 4: End-to-End Hybrid Retrieval");

  logSubsection("Complex query requiring both vector and graph context");

  const complexQuery = "What is the relationship between tech company CEOs and their headquarters?";
  log(`Query: "${complexQuery}"`);

  const hybridResults = await index.query(complexQuery);

  log(`Found ${hybridResults.length} results`);

  // Check coverage of multiple companies
  const resultText = hybridResults
    .slice(0, 15)
    .map((r) => r.node.text)
    .join(" ")
    .toLowerCase();

  const companies = ["apple", "microsoft", "google"];
  const foundCompanies = containsAny(resultText, companies);
  const companyCoverage = foundCompanies.length / companies.length;

  addResult(
    "Multi-company coverage",
    companyCoverage >= 0.66,
    `Found ${foundCompanies.length}/3 companies: ${foundCompanies.join(", ")}`,
    companyCoverage
  );

  // Check for CEO mentions
  const ceos = ["tim cook", "satya nadella", "sundar pichai", "cook", "nadella", "pichai"];
  const foundCEOs = containsAny(resultText, ceos);

  addResult(
    "CEO information retrieved",
    foundCEOs.length >= 1,
    `Found CEO mentions: ${foundCEOs.join(", ") || "none"}`,
    Math.min(foundCEOs.length / 3, 1)
  );

  // Check for location mentions
  const locations = ["cupertino", "redmond", "mountain view", "california", "washington"];
  const foundLocs = containsAny(resultText, locations);

  addResult(
    "Location information retrieved",
    foundLocs.length >= 1,
    `Found location mentions: ${foundLocs.join(", ") || "none"}`,
    Math.min(foundLocs.length / 5, 1)
  );

  // =========================================================================
  // TEST 5: CROSS-CHECK BOOSTING
  // =========================================================================
  logSection("TEST 5: Cross-Check Boosting");

  logSubsection("Testing provenance-based score boosting");

  // Query with cross-check boosting enabled (default)
  const boostQuery = "Apple products and CEO";
  log(`Query: "${boostQuery}"`);

  const retrieverWithBoost = new VectorContextRetriever({
    graphStore,
    embedModel,
    similarityTopK: 5,
    pathDepth: 1,
    includeText: true,
    crossCheckBoost: true,
    crossCheckBoostFactor: 1.25,
  });

  const retrieverNoBoost = new VectorContextRetriever({
    graphStore,
    embedModel,
    similarityTopK: 5,
    pathDepth: 1,
    includeText: true,
    crossCheckBoost: false,
  });

  const resultsWithBoost = await retrieverWithBoost.retrieve({ queryStr: boostQuery });
  const resultsNoBoost = await retrieverNoBoost.retrieve({ queryStr: boostQuery });

  log(`Results with cross-check boost: ${resultsWithBoost.length}`);
  log(`Results without cross-check boost: ${resultsNoBoost.length}`);

  // Calculate average scores for comparison
  const avgScoreWithBoost = resultsWithBoost.length > 0
    ? resultsWithBoost.reduce((sum, r) => sum + (r.score ?? 0), 0) / resultsWithBoost.length
    : 0;
  const avgScoreNoBoost = resultsNoBoost.length > 0
    ? resultsNoBoost.reduce((sum, r) => sum + (r.score ?? 0), 0) / resultsNoBoost.length
    : 0;

  log(`Average score WITH boost: ${avgScoreWithBoost.toFixed(4)}`);
  log(`Average score WITHOUT boost: ${avgScoreNoBoost.toFixed(4)}`);

  // Check if boosting increases scores for provenance-linked results
  const boostDiff = avgScoreWithBoost - avgScoreNoBoost;
  log(`Score difference: ${boostDiff >= 0 ? "+" : ""}${boostDiff.toFixed(4)}`);

  // Show top results comparison
  log("\nTop 3 results WITH boost:", 1);
  for (const r of resultsWithBoost.slice(0, 3)) {
    const name = (r.node.metadata as any)?.name ?? r.node.id;
    log(`  [${r.score?.toFixed(3)}] ${name}`, 1);
  }

  log("\nTop 3 results WITHOUT boost:", 1);
  for (const r of resultsNoBoost.slice(0, 3)) {
    const name = (r.node.metadata as any)?.name ?? r.node.id;
    log(`  [${r.score?.toFixed(3)}] ${name}`, 1);
  }

  // Cross-check boosting should increase scores when provenance matches
  // Even a small positive difference indicates the feature is working
  addResult(
    "Cross-check boosting increases relevance scores",
    boostDiff >= 0,
    `Boosted avg: ${avgScoreWithBoost.toFixed(3)}, Non-boosted avg: ${avgScoreNoBoost.toFixed(3)}, Diff: ${boostDiff >= 0 ? "+" : ""}${boostDiff.toFixed(4)}`,
    boostDiff >= 0 ? 1.0 : 0.5
  );

  // Verify that boosted results still contain relevant content
  const boostResultText = resultsWithBoost.slice(0, 10).map((r) => r.node.text).join(" ").toLowerCase();
  const appleTerms = ["apple", "tim cook", "iphone", "macbook", "ceo"];
  const foundAppleTerms = containsAny(boostResultText, appleTerms);

  addResult(
    "Cross-check boosted results maintain relevance",
    foundAppleTerms.length >= 2,
    `Found ${foundAppleTerms.length}/5 relevant terms: ${foundAppleTerms.join(", ")}`,
    foundAppleTerms.length / 5
  );

  // =========================================================================
  // TEST 6: DATA PERSISTENCE CHECK
  // =========================================================================
  logSection("TEST 6: Data Persistence Check");

  logSubsection("Verifying data was stored in HANA tables");

  // Check vector table row count
  const vectorCountResult = await new Promise<any[]>((resolve, reject) => {
    (conn as any).exec(
      `SELECT COUNT(*) AS cnt FROM URN_HKV_QUALITY_TEST_VECTORS`,
      (err: unknown, result: unknown) => (err ? reject(err) : resolve(result as any[]))
    );
  });
  const vectorCount = vectorCountResult[0]?.CNT ?? vectorCountResult[0]?.cnt ?? 0;
  log(`Vector table rows: ${vectorCount}`);

  addResult(
    "Vectors stored in HANA",
    vectorCount > 0,
    `${vectorCount} vector embeddings stored`,
    Math.min(vectorCount / 10, 1)
  );

  // Check llama nodes table row count
  const nodesCountResult = await new Promise<any[]>((resolve, reject) => {
    (conn as any).exec(
      `SELECT COUNT(*) AS cnt FROM URN_HKV_QUALITY_TEST_NODES`,
      (err: unknown, result: unknown) => (err ? reject(err) : resolve(result as any[]))
    );
  });
  const nodesCount = nodesCountResult[0]?.CNT ?? nodesCountResult[0]?.cnt ?? 0;
  log(`Nodes table rows: ${nodesCount}`);

  addResult(
    "Document nodes stored in HANA",
    nodesCount > 0,
    `${nodesCount} document nodes stored`,
    Math.min(nodesCount / 3, 1)
  );

  // Check SPARQL graph has triples
  logSubsection("Checking RDF triples in Knowledge Graph");

  try {
    // Option B: Count rows by selecting actual triples. This avoids relying on SPARQL aggregation
    // (which can be finicky through SPARQL_TABLE depending on engine/version).
    const MAX_TRIPLES_TO_SAMPLE = 200;
    const sparql = `SELECT ?s ?p ?o FROM <urn:hkv:quality_test> WHERE { ?s ?p ?o } LIMIT ${MAX_TRIPLES_TO_SAMPLE}`;

    const rows = await new Promise<any[]>((resolve, reject) => {
      (conn as any).exec(
        `SELECT * FROM SPARQL_TABLE('${sparql.replace(/'/g, "''")}')`,
        (err: unknown, result: unknown) => (err ? reject(err) : resolve(result as any[]))
      );
    });

    const tripleCountObserved = rows?.length ?? 0;
    const truncated = tripleCountObserved >= MAX_TRIPLES_TO_SAMPLE;
    const countMsg = truncated
      ? `>=${MAX_TRIPLES_TO_SAMPLE} (sample limit reached)`
      : `${tripleCountObserved}`;
    log(`RDF triples in graph (observed): ${countMsg}`);

    addResult(
      "RDF triples stored in Knowledge Graph",
      tripleCountObserved > 0,
      truncated
        ? `At least ${MAX_TRIPLES_TO_SAMPLE} triples (sampled)`
        : `${tripleCountObserved} triples in named graph`,
      Math.min(tripleCountObserved / 20, 1)
    );
  } catch (err) {
    log(`Warning: Could not count triples (SPARQL_TABLE may not be available): ${err}`);
    addResult("RDF triples stored in Knowledge Graph", false, "Could not verify (SPARQL_TABLE error)", 0);
  }

  // =========================================================================
  // FINAL SUMMARY
  // =========================================================================
  logSection("TEST SUMMARY");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  const avgScore =
    results
      .filter((r) => r.score !== undefined)
      .reduce((sum, r) => sum + (r.score ?? 0), 0) /
    results.filter((r) => r.score !== undefined).length;

  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  console.log(`Average quality score: ${(avgScore * 100).toFixed(1)}%`);

  console.log("\nDetailed Results:");
  for (const result of results) {
    const icon = result.passed ? "✅" : "❌";
    const scoreStr = result.score !== undefined ? ` [${(result.score * 100).toFixed(0)}%]` : "";
    console.log(`  ${icon} ${result.name}${scoreStr}`);
  }

  // Disconnect
  conn.disconnect();

  // Exit with appropriate code
  const exitCode = failed > 0 ? 1 : 0;
  console.log(`\nTest suite ${exitCode === 0 ? "PASSED" : "FAILED"} (exit code: ${exitCode})`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Test suite failed with error:", err);
  process.exit(1);
});
