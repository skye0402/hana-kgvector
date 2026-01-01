# hana-kgvector Tutorial

A step-by-step guide to building a hybrid GraphRAG application with SAP HANA Cloud.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setup](#setup)
3. [Step 1: Connect to HANA Cloud](#step-1-connect-to-hana-cloud)
4. [Step 2: Create the PropertyGraphIndex](#step-2-create-the-propertygraphindex)
5. [Step 3: Insert Documents](#step-3-insert-documents)
6. [Step 4: Query the Knowledge Graph](#step-4-query-the-knowledge-graph)
7. [Step 5: Tune Retrieval Parameters](#step-5-tune-retrieval-parameters)
8. [Step 6: Advanced Usage](#step-6-advanced-usage)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, ensure you have:

- **Node.js 20+** installed
- **SAP HANA Cloud** instance with:
  - Vector Engine enabled (GA since Q1 2024)
  - Knowledge Graph Engine enabled (GA since Q1 2025)
  - Minimum 3 vCPUs / 48 GB memory
- **LiteLLM Proxy** or direct access to an LLM API (OpenAI, Azure, etc.)
- **pnpm** (recommended) or npm

---

## Setup

### 1. Install the package

```bash
pnpm add hana-kgvector
# or
npm install hana-kgvector
```

### 2. Create environment file

Create a `.env.local` file in your project root:

```env
# SAP HANA Cloud Connection
HANA_HOST=your-hana-instance.hanacloud.ondemand.com:443
HANA_USER=your_user
HANA_PASSWORD=your_password

# LiteLLM Proxy (or direct OpenAI endpoint)
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=your_api_key

# Models
DEFAULT_LLM_MODEL=gpt-4o-mini
DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
```

### 3. Create your script

Create a file called `my-graph-rag.ts`:

```typescript
import "dotenv/config";
// ... we'll add the rest in the following steps
```

---

## Step 1: Connect to HANA Cloud

```typescript
import {
  loadEnv,
  createHanaConnection,
} from "hana-kgvector";

// Load environment variables
loadEnv();

async function main() {
  // Connect to HANA Cloud
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  console.log("Connected to HANA Cloud!");
  
  // ... continue with next steps
}

main().catch(console.error);
```

---

## Step 2: Create the PropertyGraphIndex

The `PropertyGraphIndex` is the main entry point. It needs:
- A **graph store** (where entities and relations are stored)
- An **embed model** (for generating vector embeddings)
- **Extractors** (for extracting entities/relations from text)

```typescript
import {
  loadEnv,
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
} from "hana-kgvector";
import OpenAI from "openai";

loadEnv();

async function main() {
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  // Create OpenAI client (via LiteLLM proxy)
  const openai = new OpenAI({
    apiKey: process.env.LITELLM_API_KEY,
    baseURL: process.env.LITELLM_PROXY_URL,
  });

  // Create embedding model adapter
  const embedModel = {
    async getTextEmbedding(text: string) {
      const res = await openai.embeddings.create({
        model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: text,
        encoding_format: "base64", // Required for some LiteLLM configurations
      });
      return res.data[0].embedding;
    },
    async getTextEmbeddingBatch(texts: string[]) {
      if (texts.length === 0) return [];
      const res = await openai.embeddings.create({
        model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: texts,
        encoding_format: "base64",
      });
      return res.data.map((d) => d.embedding);
    },
  };

  // Create LLM client adapter for entity extraction
  const llmClient = {
    async structuredPredict<T>(schema: any, prompt: string): Promise<T> {
      const res = await openai.chat.completions.create({
        model: process.env.DEFAULT_LLM_MODEL ?? "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      let content = res.choices[0]?.message?.content ?? "{}";
      // Strip markdown code blocks if present
      content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      return JSON.parse(content);
    },
  };

  // Create the HANA-backed graph store
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: "my_knowledge_graph",  // Your graph's identifier
    // Tables are auto-created. Use resetTables: true during development to start fresh.
  });

  // Define your knowledge graph schema
  const schema = {
    entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT"],
    relationTypes: ["WORKS_AT", "LOCATED_IN", "PRODUCES", "CEO_OF"],
    validationSchema: [
      ["PERSON", "WORKS_AT", "ORGANIZATION"],
      ["PERSON", "CEO_OF", "ORGANIZATION"],
      ["ORGANIZATION", "LOCATED_IN", "LOCATION"],
      ["ORGANIZATION", "PRODUCES", "PRODUCT"],
    ],
  };

  // Create the PropertyGraphIndex
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema,
        maxTripletsPerChunk: 10,  // Max entities/relations per document
      }),
      new ImplicitPathExtractor(),  // Adds CHUNK -> DOCUMENT relations
    ],
    embedKgNodes: true,  // Embed entity nodes for vector search
  });

  console.log("PropertyGraphIndex created!");
}

main().catch(console.error);
```

---

## Step 3: Insert Documents

Now let's add some documents to the knowledge graph:

```typescript
// Add this after creating the index

const documents = [
  {
    id: "doc_apple",
    text: "Apple Inc. is headquartered in Cupertino, California. Tim Cook is the CEO of Apple. Apple produces the iPhone and MacBook.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
  {
    id: "doc_microsoft",
    text: "Microsoft Corporation is located in Redmond, Washington. Satya Nadella serves as CEO. Microsoft develops Windows and Azure cloud services.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
  {
    id: "doc_google",
    text: "Google, a subsidiary of Alphabet Inc., is based in Mountain View, California. Sundar Pichai is the CEO. Google created the Android operating system.",
    metadata: { documentId: "tech_companies", source: "wikipedia" },
  },
];

console.log("Inserting documents...");
const insertedNodes = await index.insert(documents);
console.log(`Inserted ${insertedNodes.length} documents`);

// Check what was extracted
for (const node of insertedNodes) {
  const entities = node.metadata.kg_nodes as any[] ?? [];
  const relations = node.metadata.kg_relations as any[] ?? [];
  console.log(`  ${node.id}: ${entities.length} entities, ${relations.length} relations`);
}
```

**What happens during insert:**
1. Each document is processed by the extractors
2. `SchemaLLMPathExtractor` calls the LLM to extract entities and relations
3. `ImplicitPathExtractor` adds structural relations (e.g., chunk → document)
4. Entity nodes are embedded using the embed model
5. Everything is stored in HANA (vectors + RDF triples)

---

## Step 4: Query the Knowledge Graph

Now query your knowledge graph:

```typescript
// Simple query
console.log("\n--- Query: Who is the CEO of Apple? ---");
const results = await index.query("Who is the CEO of Apple?");

for (const result of results) {
  console.log(`[${result.score.toFixed(3)}] ${result.node.text?.substring(0, 100)}...`);
}
```

**What happens during query:**
1. Your query is embedded using the embed model
2. Vector similarity search finds the most relevant entity nodes
3. Graph traversal expands from those nodes to find related triplets
4. Results are ranked by similarity score and returned

---

## Step 5: Tune Retrieval Parameters

The `query()` method accepts options to tune retrieval:

```typescript
// Retrieve more results with deeper graph traversal
const results = await index.query("Tech companies in California", {
  similarityTopK: 10,    // Retrieve top 10 similar nodes (default: 4)
  pathDepth: 2,          // Traverse 2 hops in the graph (default: 1)
  limit: 50,             // Return up to 50 results (default: 30)
  similarityScore: 0.5,  // Only include results with score >= 0.5
});

console.log(`Found ${results.length} results`);
```

### Parameter Reference

| Parameter | Default | Description |
|-----------|---------|-------------|
| `similarityTopK` | 4 | Number of top similar entity nodes to retrieve via vector search |
| `pathDepth` | 1 | How many hops to traverse in the knowledge graph from matched nodes |
| `limit` | 30 | Maximum number of triplets/results to return after graph expansion |
| `similarityScore` | - | Minimum similarity threshold (0.0-1.0). Results below this are filtered out |
| `crossCheckBoost` | true | Enable cross-check boosting for better relevance |
| `crossCheckBoostFactor` | 1.25 | Score multiplier when provenance matches (25% boost) |

### Cross-Check Boosting

Cross-check boosting improves retrieval quality by combining vector similarity with graph provenance:

1. **Vector search** finds semantically similar entity nodes
2. **Graph traversal** expands to find related facts
3. **Cross-check**: If a fact originated from the same document as a vector-matched entity, boost its score

This rewards results that are **both semantically relevant AND have explicit graph connections**.

```typescript
// Disable cross-check boosting for raw vector scores
const results = await index.query("Apple CEO", { crossCheckBoost: false });

// Increase boost factor for stronger provenance preference
const results = await index.query("Apple CEO", { crossCheckBoostFactor: 1.5 });
```

### When to adjust these parameters:

- **Low recall (missing relevant results)?** → Increase `similarityTopK` and `pathDepth`
- **Too many irrelevant results?** → Set `similarityScore` threshold, decrease `limit`
- **Queries about relationships?** → Increase `pathDepth` to traverse more connections
- **Simple entity lookups?** → Keep `pathDepth: 1`, lower `similarityTopK`

---

## Step 6: Advanced Usage

### Using the Retriever Directly

For more control, use the retriever directly:

```typescript
import { VectorContextRetriever } from "hana-kgvector";

const retriever = new VectorContextRetriever({
  graphStore,
  embedModel,
  similarityTopK: 8,
  pathDepth: 2,
  limit: 50,
  similarityScore: 0.4,
  includeText: true,  // Include source text in results
});

const nodes = await retriever.retrieve({ queryStr: "Apple CEO" });
```

### Custom Extraction Schema

Define domain-specific entity and relation types:

```typescript
const medicalSchema = {
  entityTypes: ["DISEASE", "SYMPTOM", "TREATMENT", "DRUG", "BODY_PART"],
  relationTypes: ["CAUSES", "TREATS", "AFFECTS", "INTERACTS_WITH"],
  validationSchema: [
    ["DISEASE", "CAUSES", "SYMPTOM"],
    ["DRUG", "TREATS", "DISEASE"],
    ["DISEASE", "AFFECTS", "BODY_PART"],
    ["DRUG", "INTERACTS_WITH", "DRUG"],
  ],
};

const extractor = new SchemaLLMPathExtractor({
  llm: llmClient,
  schema: medicalSchema,
  maxTripletsPerChunk: 15,
  strict: true,  // Only allow relations defined in validationSchema
});
```

### Multi-Tenancy

Isolate data for different domains or tenants using separate graph names:

```typescript
// Tenant 1: Finance data
const financeStore = new HanaPropertyGraphStore(conn, {
  graphName: "finance_graph",
});
const financeIndex = new PropertyGraphIndex({
  propertyGraphStore: financeStore,
  embedModel,
  kgExtractors: [...],
});

// Tenant 2: HR data (completely isolated)
const hrStore = new HanaPropertyGraphStore(conn, {
  graphName: "hr_graph",
});
const hrIndex = new PropertyGraphIndex({
  propertyGraphStore: hrStore,
  embedModel,
  kgExtractors: [...],
});
```

Each `graphName` creates a separate RDF named graph and vector table.

### Resetting Data (Development Only)

During development, you may want to start fresh:

```typescript
const graphStore = new HanaPropertyGraphStore(conn, {
  graphName: "my_test_graph",
  resetTables: true,  // DROP and recreate tables + clear RDF graph
});
```

⚠️ **Warning**: Never use `resetTables: true` in production!

---

## Troubleshooting

### "Embedding API returns zero vectors"

**Cause**: Some LiteLLM proxy configurations require `encoding_format: "base64"`.

**Solution**: Ensure your embed model uses:
```typescript
encoding_format: "base64"
```

### "SyntaxError: Unexpected token" when parsing LLM response

**Cause**: Some LLMs wrap JSON in markdown code blocks.

**Solution**: Strip code blocks before parsing:
```typescript
content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
return JSON.parse(content);
```

### Low similarity scores (all near 0)

**Cause**: Likely embedding dimension mismatch or storage issue.

**Debug steps**:
1. Check that embeddings are non-zero: `console.log(embedding.slice(0, 5))`
2. Verify vectors are stored: `SELECT COUNT(*) FROM YOUR_VECTORS_TABLE`
3. Run a direct COSINE_SIMILARITY query in HANA

### "SPARQL_EXECUTE" errors

**Cause**: Knowledge Graph Engine may not be enabled.

**Solution**: Ensure your HANA Cloud instance has KG Engine enabled (requires minimum 3 vCPU / 48 GB).

---

## Complete Example

Here's a complete working example:

```typescript
import "dotenv/config";
import {
  loadEnv,
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
} from "hana-kgvector";
import OpenAI from "openai";

loadEnv();

async function main() {
  // 1. Connect
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  // 2. Setup OpenAI client
  const openai = new OpenAI({
    apiKey: process.env.LITELLM_API_KEY,
    baseURL: process.env.LITELLM_PROXY_URL,
  });

  const embedModel = {
    async getTextEmbedding(text: string) {
      const res = await openai.embeddings.create({
        model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: text,
        encoding_format: "base64",
      });
      return res.data[0].embedding;
    },
    async getTextEmbeddingBatch(texts: string[]) {
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
      let content = res.choices[0]?.message?.content ?? "{}";
      content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      return JSON.parse(content);
    },
  };

  // 3. Create graph store and index
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: "tutorial_graph",
  });

  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema: {
          entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT"],
          relationTypes: ["WORKS_AT", "LOCATED_IN", "PRODUCES", "CEO_OF"],
          validationSchema: [
            ["PERSON", "WORKS_AT", "ORGANIZATION"],
            ["PERSON", "CEO_OF", "ORGANIZATION"],
            ["ORGANIZATION", "LOCATED_IN", "LOCATION"],
            ["ORGANIZATION", "PRODUCES", "PRODUCT"],
          ],
        },
      }),
      new ImplicitPathExtractor(),
    ],
    embedKgNodes: true,
  });

  // 4. Insert documents
  await index.insert([
    {
      id: "doc1",
      text: "Apple Inc. is headquartered in Cupertino. Tim Cook is the CEO.",
      metadata: { source: "example" },
    },
  ]);

  // 5. Query
  const results = await index.query("Who is Apple's CEO?", {
    similarityTopK: 5,
    pathDepth: 1,
  });

  for (const r of results) {
    console.log(`[${r.score.toFixed(3)}] ${r.node.text}`);
  }

  conn.disconnect();
}

main().catch(console.error);
```

---

## Next Steps

- Read the [README.md](./README.md) for API reference
- Check out the [PRD.md](./PRD.md) for architectural decisions
- Run the quality test: `pnpm exec tsx scripts/test-quality.ts`
- Explore the source code in `src/graph/`

Happy building! 🚀
