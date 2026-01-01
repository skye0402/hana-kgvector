# hana-kgvector

A TypeScript framework for building **hybrid GraphRAG** applications using SAP HANA Cloud as the unified backend for knowledge graphs (RDF) and vector embeddings.

## Features

- **Unified Storage**: SAP HANA Cloud for both RDF triples (Knowledge Graph Engine) and vector embeddings (Vector Engine)
- **PropertyGraphIndex**: LlamaIndex-inspired API for building and querying property graphs
- **Hybrid Retrieval**: Combine vector similarity search with graph traversal
- **Schema-Guided Extraction**: Extract entities and relations from documents using LLMs
- **Multi-Tenancy**: Isolate data into logical "Spaces" for different domains
- **LLM Agnostic**: Works with any LLM via LiteLLM proxy (OpenAI, Anthropic, Azure, etc.)

## Installation

```bash
pnpm add hana-kgvector
# or
npm install hana-kgvector
```

## Quick Start

### 1. Setup Environment

Create a `.env.local` file:

```env
# SAP HANA Cloud
HANA_HOST=your-hana-instance.hanacloud.ondemand.com:443
HANA_USER=your_user
HANA_PASSWORD=your_password

# LiteLLM Proxy
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=your_key

# Models
DEFAULT_LLM_MODEL=gpt-4o-mini
DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
```

### 2. Create a PropertyGraphIndex

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

// Load environment
loadEnv();

// Connect to HANA
const conn = await createHanaConnection({
  host: process.env.HANA_HOST!,
  user: process.env.HANA_USER!,
  password: process.env.HANA_PASSWORD!,
});

// Create OpenAI client (via LiteLLM)
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Create embed model adapter
const embedModel = {
  async getTextEmbedding(text: string) {
    const res = await openai.embeddings.create({
      model: process.env.DEFAULT_EMBEDDING_MODEL ?? "text-embedding-3-small",
      input: text,
      encoding_format: "base64", // Required for some LiteLLM proxy configurations
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

// Create LLM client adapter
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
    return JSON.parse(content);
  },
};

// Create HANA-backed graph store
const graphStore = new HanaPropertyGraphStore(conn, {
  graphName: "my_knowledge_graph",  // RDF named graph identifier
  // vectorDimension is auto-detected from first embedding
});

// Create PropertyGraphIndex with extractors
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
    }),
    new ImplicitPathExtractor(),
  ],
  embedKgNodes: true,
});
```

### 3. Insert Documents

```typescript
await index.insert([
  {
    id: "doc_1",
    text: "Alice works at SAP in Walldorf. She collaborates with Bob.",
    metadata: { documentId: "company_info" },
  },
  {
    id: "doc_2", 
    text: "SAP produces enterprise software and is headquartered in Germany.",
    metadata: { documentId: "company_info" },
  },
]);
```

### 4. Query the Graph

```typescript
// Simple query
const results = await index.query("Who works at SAP?");

for (const result of results) {
  console.log(`[${result.score.toFixed(3)}] ${result.node.text}`);
}

// Advanced: Use retriever directly
import { VectorContextRetriever } from "hana-kgvector";

const retriever = new VectorContextRetriever({
  graphStore,
  embedModel,
  similarityTopK: 5,
  pathDepth: 2,  // Traverse 2 hops from matched nodes
});

const nodes = await retriever.retrieve({ queryStr: "SAP employees" });
```

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        hana-kgvector                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ PropertyGraphIndex │  │   Extractors     │  │  Retrievers    │  │
│  │  - insert()        │  │  - SchemaLLM     │  │  - Vector      │  │
│  │  - query()         │  │  - Implicit      │  │  - PGRetriever │  │
│  └────────┬───────────┘  └──────────────────┘  └────────────────┘  │
│           │                                                        │
│           ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              HanaPropertyGraphStore                      │      │
│  │  - upsertNodes()   - vectorQuery()   - getRelMap()       │      │
│  └──────────────────────────────────────────────────────────┘      │
│           │                                                        │
│           ▼                                                        │
│  ┌──────────────────────┐    ┌─────────────────────┐               │
│  │   HANA Vector Engine │    │   HANA KG Engine    │               │
│  │   (REAL_VECTOR)      │    │   (SPARQL_EXECUTE)  │               │
│  └──────────────────────┘    └─────────────────────┘               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Core Components

### PropertyGraphIndex

Main entry point for building and querying knowledge graphs.

```typescript
const index = new PropertyGraphIndex({
  propertyGraphStore: graphStore,  // Required: HANA-backed store
  embedModel,                       // Optional: for vector search
  kgExtractors: [...],             // Optional: extraction pipeline
  embedKgNodes: true,              // Embed entity nodes
});
```

### HanaPropertyGraphStore

HANA-backed implementation of PropertyGraphStore interface.

```typescript
const store = new HanaPropertyGraphStore(conn, {
  graphName: "my_graph",              // RDF named graph identifier
  vectorTableName: "MY_VECTORS",      // Optional: custom table name
  // vectorDimension auto-detected from embeddings (supports 1536, 3072, etc.)
});
```

### Extractors

Transform text nodes into entities and relations.

| Extractor | Description |
|-----------|-------------|
| `SchemaLLMPathExtractor` | Schema-guided extraction with LLM |
| `ImplicitPathExtractor` | Extract structure-based relations (CHUNK → DOCUMENT) |

### Retrievers

Retrieve relevant context from the graph.

| Retriever | Description |
|-----------|-------------|
| `VectorContextRetriever` | Vector similarity → graph traversal |
| `PGRetriever` | Orchestrates multiple sub-retrievers |

## Space Management

Isolate data into logical spaces for multi-tenancy.

```typescript
import { SpaceManager } from "hana-kgvector";

const spaces = new SpaceManager(conn);

// Create a space
const space = await spaces.create({
  id: "finance-contracts",
  name: "Finance Contract Data",
  description: "Legal contracts and obligations",
});

// List spaces
const allSpaces = await spaces.list();
```

## Low-Level Access

### Direct Vector Operations

```typescript
import { HanaVectorStore } from "hana-kgvector";

const vectorStore = new HanaVectorStore(conn, { tableName: "MY_CHUNKS" });
await vectorStore.ensureTable({ vectorDimension: 1536 });

await vectorStore.addChunk({
  id: "chunk_1",
  spaceId: "my-space",
  content: "Document text...",
  embedding: [0.1, 0.2, ...],
});

const results = await vectorStore.similaritySearch({
  spaceId: "my-space",
  queryEmbedding: [...],
  topK: 10,
});
```

### Direct SPARQL Access

```typescript
import { HanaSparqlStore } from "hana-kgvector";

const sparql = new HanaSparqlStore(conn);

// Execute SPARQL query
const result = await sparql.execute({
  sparql: `SELECT ?s ?p ?o FROM <my-graph> WHERE { ?s ?p ?o } LIMIT 10`,
});

// Load Turtle data
await sparql.loadTurtle({
  turtle: `<urn:entity:1> <urn:rel:knows> <urn:entity:2> .`,
  graphName: "urn:hkv:my_graph",
});
```

## Requirements

- **Node.js** 20+
- **SAP HANA Cloud** with:
  - Vector Engine enabled (GA since Q1 2024)
  - Knowledge Graph Engine enabled (GA since Q1 2025)
  - Minimum 3 vCPUs / 48 GB memory
- **LiteLLM Proxy** (recommended) or direct LLM API access

## Scripts

```bash
# Build
pnpm run build

# Test
pnpm run test

# Validate HANA connection
pnpm run phase0:hana

# Validate LiteLLM connection
pnpm run phase0:litellm

# Run PropertyGraphIndex smoke test
pnpm run smoke:pg

# Run quality test suite (comprehensive testing)
pnpm exec tsx scripts/test-quality.ts
```

## Quality Test Results

The quality test suite validates entity extraction, vector retrieval, and graph traversal:

| Test | Score |
|------|-------|
| Entity Extraction (Organizations, People, Locations) | 100% |
| Relation Extraction | 100% |
| Vector Retrieval Relevance | 100% |
| Graph Traversal | 100% |
| Data Persistence | 100% |
| **Overall** | **91%** |

## License

MIT

## Contributing

Contributions welcome! Please read the PRD.md for architectural decisions and design principles.
