# hana-kgvector: Product Requirements Document

## Executive Summary

**hana-kgvector** is a TypeScript framework for building hybrid GraphRAG (Graph Retrieval-Augmented Generation) applications using SAP HANA Cloud as the unified backend for both knowledge graphs (RDF triple store) and vector embeddings. The framework enables:

- **Ingestion**: Automated extraction of knowledge graphs and vector embeddings from documents (PDFs, text, etc.)
- **Retrieval**: Hybrid search combining semantic vector similarity with graph traversal
- **Multi-tenancy**: Logical separation of data into isolated "Spaces" for different domains

The framework leverages **LlamaIndex.TS** for orchestration and **LiteLLM** as a unified gateway to LLMs, ensuring provider-agnostic access to state-of-the-art models.

---

## 1. Problem Statement

### 1.1 Current Challenges

Traditional RAG systems using only vector databases face limitations when dealing with complex, interconnected technical documentation:

| Challenge | Description |
|-----------|-------------|
| **Multi-hop reasoning** | Vector search finds documents containing keywords but misses logical dependencies (e.g., "What happens to Module A if I upgrade Module B?") |
| **Context fragmentation** | Related concepts scattered across documents are not linked |
| **Domain isolation** | No built-in mechanism to separate unrelated knowledge domains |
| **Vendor lock-in** | Tight coupling to specific LLM providers |

### 1.2 Target Use Cases

The framework targets organizations managing diverse, complex documentation:

- **Finance Contract Data** - Legal terms, obligations, party relationships
- **SAP S/4HANA Capabilities** - Modules, dependencies, configuration, T-Codes
- **Truck Assembly Specifications** - Parts, assemblies, manufacturing processes
- **Medical Database for Skin** - Conditions, treatments, drug interactions

These domains are **disjunct** and should not cross-contaminate during retrieval.

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. **Unified Data Layer**: Single SAP HANA Cloud instance for both vector embeddings and RDF knowledge graphs
2. **Hybrid Retrieval**: Combine vector similarity search with SPARQL graph traversal
3. **Space Isolation**: Logical multi-tenancy with configurable isolation boundaries
4. **LLM Agnosticism**: Support any LLM provider via LiteLLM proxy
5. **TypeScript-First**: Performant, type-safe implementation using LlamaIndex.TS
6. **Schema Flexibility**: Support both strict ontologies and free-form extraction

### 2.2 Non-Goals

- Real-time streaming ingestion (batch processing only for v1)
- OLAP/analytical workloads on the knowledge graph
- Custom UI components (API/SDK only)
- On-premise HANA deployment support (Cloud only)

---

## 3. Technical Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              hana-kgvector                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │   Ingestion  │    │   Retrieval  │    │    Space     │                  │
│  │    Engine    │    │    Engine    │    │   Manager    │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │                   │                   │                          │
│         ▼                   ▼                   ▼                          │
│  ┌─────────────────────────────────────────────────────────────────┐       │
│  │                    LlamaIndex.TS Core                           │       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │       │
│  │  │  Document   │  │  Property   │  │   Hybrid Retriever      │  │       │
│  │  │   Loaders   │  │ Graph Index │  │ (Vector + Graph + Text) │  │       │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │       │
│  └─────────────────────────────────────────────────────────────────┘       │
│                                │                                           │
│         ┌──────────────────────┼──────────────────────┐                    │
│         ▼                      ▼                      ▼                    │
│  ┌─────────────┐       ┌─────────────┐       ┌─────────────┐              │
│  │   LiteLLM   │       │ HANA Vector │       │  HANA KG    │              │
│  │    Proxy    │       │   Engine    │       │   Engine    │              │
│  └──────┬──────┘       └──────┬──────┘       └──────┬──────┘              │
│         │                     │                     │                      │
└─────────┼─────────────────────┼─────────────────────┼──────────────────────┘
          │                     │                     │
          ▼                     └──────────┬──────────┘
   ┌─────────────┐                         ▼
   │ LLM Providers│              ┌─────────────────────┐
   │ (OpenAI,     │              │   SAP HANA Cloud    │
   │  Anthropic,  │              │  ┌───────┬────────┐ │
   │  Azure, etc.)│              │  │Vector │  RDF   │ │
   │              │              │  │Engine │ Triple │ │
   └──────────────┘              │  │       │ Store  │ │
                                 │  └───────┴────────┘ │
                                 └─────────────────────┘
```

### 3.2 Component Details

#### 3.2.1 SAP HANA Cloud Integration

SAP HANA Cloud provides a unified multi-model database with native support for:

**Vector Engine (GA since Q1 2024)**
- `REAL_VECTOR` data type for storing embeddings
- `VECTOR_EMBEDDING()` function for in-database embedding generation
- `COSINE_SIMILARITY()`, `L2DISTANCE()` for similarity computations
- HNSW index for approximate nearest neighbor search
- Configurable parameters: `m` (neighbors), `ef_construction`, `ef_search`

```sql
-- Example: Create vector table with HNSW index
CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    space_id VARCHAR(100),
    content NCLOB,
    embedding REAL_VECTOR(1536)
);

CREATE VECTOR INDEX doc_vec_idx 
ON documents(embedding) 
USING HNSW 
WITH PARAMETERS (M=64, EF_CONSTRUCTION=128);
```

**Knowledge Graph Engine (GA since Q1 2025)**
- Native RDF triple store (subject-predicate-object)
- SPARQL 1.1 Query and Update support
- SQL/SPARQL interoperability via:
  - `SPARQL_TABLE()` - Embed SPARQL in SQL
  - `SPARQL_EXECUTE()` - Execute SPARQL statements
  - `SQL_TABLE()` - Embed SQL in SPARQL
- Named graphs for logical partitioning

```sql
-- Example: Load RDF triples
CALL SPARQL_EXECUTE(
    '<ttl_data>',
    'rqx-load-graphname: finance_contracts',
    '',
    NULL
);

-- Example: Query with SPARQL_TABLE
SELECT * FROM SPARQL_TABLE('
    SELECT ?subject ?predicate ?object
    FROM <finance_contracts>
    WHERE { ?subject ?predicate ?object }
');
```

**Prerequisites**
- SAP HANA Cloud instance with:
  - Minimum 3 vCPUs / 48 GB memory (Triple Store requirement)
  - Recommended: 8+ vCPUs for production workloads
  - Triple Store enabled in Advanced Settings
  - NLP enabled for `VECTOR_EMBEDDING()` function

#### 3.2.2 LlamaIndex.TS Integration

LlamaIndex.TS provides the orchestration layer with these key components:

**PropertyGraphIndex**
- Unified index combining graph structure and vector embeddings
- Multiple extraction strategies:
  - `SchemaLLMPathExtractor` - Schema-guided extraction with validation
  - `SimpleLLMPathExtractor` - Free-form LLM-based extraction
  - `ImplicitPathExtractor` - Structure-based relationships (PREVIOUS, NEXT, SOURCE)
  - `DynamicLLMPathExtractor` - LLM-inferred entities and relations

**Retrieval Strategies**
- `VectorContextRetriever` - Similarity-based node retrieval with graph traversal
- `LLMSynonymRetriever` - Keyword/synonym expansion
- `CypherTemplateRetriever` - Parameterized graph queries
- `TextToCypherRetriever` - LLM-generated graph queries
- Custom hybrid retrievers combining multiple strategies

```typescript
// Example: Hybrid retrieval setup
import { PropertyGraphIndex, VectorContextRetriever, LLMSynonymRetriever } from "llamaindex";

const vectorRetriever = new VectorContextRetriever(
  index.propertyGraphStore,
  { 
    vectorStore: index.vectorStore,
    embedModel,
    includeText: true,
    similarityTopK: 5,
    pathDepth: 2  // Traverse 2 hops from matched nodes
  }
);

const synonymRetriever = new LLMSynonymRetriever(
  index.propertyGraphStore,
  { llm }
);

const retriever = index.asRetriever({
  subRetrievers: [vectorRetriever, synonymRetriever]
});
```

#### 3.2.3 LiteLLM Integration

LiteLLM serves as the unified LLM gateway providing:

**Core Capabilities**
- OpenAI-compatible API for 100+ LLM providers
- Consistent input/output format across providers
- Built-in retry logic and fallback handling
- Cost tracking and budget management
- Request/response logging

**Deployment Options**
- Proxy server mode (recommended for production)
- Direct SDK integration

```yaml
# config.yaml for LiteLLM Proxy
model_list:
  - model_name: gpt-4
    litellm_params:
      model: openai/gpt-4
      api_key: os.environ/OPENAI_API_KEY
      
  - model_name: claude-3-5-sonnet
    litellm_params:
      model: anthropic/claude-3-5-sonnet-20241022
      api_key: os.environ/ANTHROPIC_API_KEY
      
  - model_name: embeddings
    litellm_params:
      model: openai/text-embedding-3-small
      api_key: os.environ/OPENAI_API_KEY

litellm_settings:
  drop_params: true
  set_verbose: false
```

```typescript
// Client usage with OpenAI SDK
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "any-key",  // LiteLLM proxy handles auth
  baseURL: "http://localhost:4000"
});

const response = await client.chat.completions.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "Extract entities from this text..." }]
});
```

---

## 4. Data Model

### 4.1 Space (Multi-Tenant Isolation)

A **Space** represents an isolated knowledge domain with its own:
- RDF named graph
- Vector table partition
- Schema/ontology definitions
- Access control policies

```typescript
interface Space {
  id: string;                    // Unique identifier (e.g., "finance-contracts")
  name: string;                  // Display name
  description?: string;
  
  // Schema configuration
  ontology?: OntologyConfig;     // Optional strict ontology
  entityTypes: string[];         // Allowed entity types
  relationTypes: string[];       // Allowed relation types
  
  // Storage configuration
  rdfGraphName: string;          // Named graph in HANA KG
  vectorTableName: string;       // Vector table name/partition
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  documentCount: number;
  tripleCount: number;
}

interface OntologyConfig {
  // Entity type -> allowed relations mapping
  schema: Record<string, string[]>;
  strictValidation: boolean;
}
```

### 4.2 Schema Definition with Zod

Schemas are defined using **Zod** for runtime validation and OpenAI structured output compatibility:

```typescript
import { z } from "zod";

// Define entity types as Zod enum
const EntityType = z.enum([
  "MODULE", "TCODE", "CONFIG_PARAM", "TABLE", "BAPI", "ERROR"
]);

// Define relation types as Zod enum  
const RelationType = z.enum([
  "REQUIRES", "CONFIGURES", "CALLS", "DEPENDS_ON", "RAISES"
]);

// Schema for extracted triples (used with OpenAI structured output)
const ExtractedTriple = z.object({
  subject: z.object({
    name: z.string().describe("Entity name"),
    type: EntityType.describe("Entity type"),
    properties: z.record(z.string()).optional(),
  }),
  predicate: RelationType.describe("Relationship type"),
  object: z.object({
    name: z.string().describe("Target entity name"),
    type: EntityType.describe("Target entity type"),
    properties: z.record(z.string()).optional(),
  }),
  confidence: z.number().min(0).max(1).describe("Extraction confidence"),
});

const ExtractionResult = z.object({
  triples: z.array(ExtractedTriple),
});

// Usage with OpenAI structured output
const completion = await openai.beta.chat.completions.parse({
  model: "gpt-4o",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: chunkText }
  ],
  response_format: zodResponseFormat(ExtractionResult, "extraction"),
});

const result = completion.choices[0].message.parsed;
// result is fully typed as ExtractionResult
```

**Example Spaces:**

```typescript
const financeSpace: Space = {
  id: "finance-contracts",
  name: "Finance Contract Data",
  entityTypes: ["CONTRACT", "PARTY", "OBLIGATION", "TERM", "AMOUNT"],
  relationTypes: ["SIGNED_BY", "OBLIGATES", "REFERENCES", "HAS_VALUE"],
  ontology: {
    schema: {
      "CONTRACT": ["SIGNED_BY", "HAS_TERM", "OBLIGATES"],
      "PARTY": ["SIGNED_BY", "OBLIGATES"],
      "OBLIGATION": ["REFERENCES", "HAS_VALUE"],
    },
    strictValidation: true
  },
  rdfGraphName: "urn:hana-kgvector:finance-contracts",
  vectorTableName: "VECTORS_FINANCE_CONTRACTS"
};

const sapSpace: Space = {
  id: "sap-s4hana",
  name: "SAP S/4HANA Capabilities", 
  entityTypes: ["MODULE", "TCODE", "CONFIG_PARAM", "TABLE", "BAPI", "ERROR"],
  relationTypes: ["REQUIRES", "CONFIGURES", "CALLS", "DEPENDS_ON", "RAISES"],
  rdfGraphName: "urn:hana-kgvector:sap-s4hana",
  vectorTableName: "VECTORS_SAP_S4HANA"
};
```

### 4.2 Document Model

```typescript
interface Document {
  id: string;
  spaceId: string;
  
  // Source information
  sourceUri: string;             // Original file path/URL
  sourceType: "pdf" | "text" | "html" | "markdown";
  
  // Content
  rawContent: string;            // Original text
  chunks: DocumentChunk[];       // Processed chunks
  
  // Extraction results
  entities: Entity[];
  relations: Relation[];
  
  // Metadata
  metadata: Record<string, any>;
  createdAt: Date;
  processedAt?: Date;
  status: "pending" | "processing" | "completed" | "failed";
}

interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  embedding?: number[];
  
  // Position in document
  startOffset: number;
  endOffset: number;
  
  // Linked entities in this chunk
  entityRefs: string[];
}

interface Entity {
  id: string;
  name: string;
  type: string;                  // From Space.entityTypes
  properties: Record<string, any>;
  sourceChunkIds: string[];      // Provenance
}

interface Relation {
  id: string;
  type: string;                  // From Space.relationTypes
  subjectId: string;             // Entity ID
  objectId: string;              // Entity ID
  properties: Record<string, any>;
  sourceChunkIds: string[];
}
```

### 4.3 RDF Triple Mapping

Entities and relations are serialized to RDF triples:

```turtle
# Namespace definitions
@prefix hkv: <urn:hana-kgvector:> .
@prefix space: <urn:hana-kgvector:finance-contracts:> .

# Entity as RDF resource
space:entity_001 a hkv:CONTRACT ;
    hkv:name "Master Service Agreement 2024" ;
    hkv:property_effective_date "2024-01-01"^^xsd:date ;
    hkv:sourceChunk space:chunk_042 .

# Relation as RDF triple
space:entity_001 hkv:SIGNED_BY space:entity_002 .
space:entity_002 a hkv:PARTY ;
    hkv:name "Acme Corporation" .
```

---

## 5. API Design

### 5.1 Core SDK Interface

```typescript
// Main entry point
import { HanaKGVector, Space, IngestionConfig, RetrievalConfig } from "hana-kgvector";

// Initialize framework
const hkv = new HanaKGVector({
  hana: {
    host: process.env.HANA_HOST,
    port: 443,
    user: process.env.HANA_USER,
    password: process.env.HANA_PASSWORD,
  },
  litellm: {
    baseUrl: "http://localhost:4000",
    apiKey: process.env.LITELLM_API_KEY,
  },
  defaultLLM: "gpt-4",
  defaultEmbeddingModel: "text-embedding-3-small",
});
```

### 5.2 Space Management

```typescript
// Create a new space
const space = await hkv.spaces.create({
  id: "medical-skin",
  name: "Medical Database for Skin",
  entityTypes: ["CONDITION", "SYMPTOM", "TREATMENT", "DRUG", "BODY_PART"],
  relationTypes: ["TREATS", "CAUSES", "CONTRAINDICATES", "AFFECTS"],
  ontology: {
    schema: {
      "CONDITION": ["CAUSES", "AFFECTS"],
      "TREATMENT": ["TREATS", "CONTRAINDICATES"],
      "DRUG": ["TREATS", "CONTRAINDICATES"],
    },
    strictValidation: false  // Allow LLM to discover new relations
  }
});

// List spaces
const spaces = await hkv.spaces.list();

// Get space statistics
const stats = await hkv.spaces.getStats("medical-skin");
// { documentCount: 150, tripleCount: 4500, chunkCount: 2300 }

// Delete space (with confirmation)
await hkv.spaces.delete("medical-skin", { confirm: true });
```

### 5.3 Ingestion Pipeline

The ingestion pipeline follows a specific order to ensure **provenance linking** between vector chunks and graph nodes:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        INGESTION PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │  LOAD   │───▶│   CHUNK     │───▶│  VECTORIZE  │───▶│  EXTRACT    │  │
│  │  (PDF)  │    │  (Semantic) │    │  (Embed)    │    │  (Triples)  │  │
│  └─────────┘    └─────────────┘    └──────┬──────┘    └──────┬──────┘  │
│                                           │                  │         │
│                                           ▼                  ▼         │
│                                    ┌─────────────┐    ┌─────────────┐  │
│                                    │   Vector    │◀──▶│    RDF      │  │
│                                    │   Table     │    │   Store     │  │
│                                    │  (ChunkID)  │    │  (Triples)  │  │
│                                    └─────────────┘    └─────────────┘  │
│                                           │                  │         │
│                                           └────────┬─────────┘         │
│                                                    ▼                   │
│                                           ┌─────────────────┐          │
│                                           │  PROVENANCE     │          │
│                                           │  hkv:sourceChunk│          │
│                                           └─────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Pipeline Steps:**

| Step | Action | Output |
|------|--------|--------|
| 1. **Load** | Parse PDF/text into raw content | `Document` |
| 2. **Chunk** | Split into semantic chunks | `DocumentChunk[]` with IDs |
| 3. **Hash** | Compute MD5 of chunk content | Skip if hash exists (cost savings) |
| 4. **Vectorize** | Generate embedding via LiteLLM | Store in Vector Table with `ChunkID` |
| 5. **Extract** | Send chunk to LLM for triple extraction | `Entity[]`, `Relation[]` |
| 6. **Link** | Add `hkv:sourceChunkID` to each triple | Provenance for hybrid retrieval |
| 7. **Store** | Batch insert triples to RDF Store | Complete |

**API Usage:**

```typescript
const ingestionJob = await hkv.ingest({
  spaceId: "sap-s4hana",
  
  sources: [
    { type: "file", path: "./docs/s4hana-config-guide.pdf" },
    { type: "directory", path: "./docs/tcodes/", pattern: "*.md" },
  ],
  
  chunking: {
    strategy: "semantic",        // or "fixed", "sentence"
    chunkSize: 512,
    chunkOverlap: 50,
  },
  
  extraction: {
    strategy: "schema-guided",   // or "dynamic", "implicit"
    maxTripletsPerChunk: 10,
    includeProperties: true,
  },
  
  options: {
    parallelism: 4,
    continueOnError: true,
    skipExistingHashes: true,    // Cost optimization
  }
});

// Monitor progress
ingestionJob.on("progress", (p) => console.log(`${p.completed}/${p.total}`));
await ingestionJob.wait();
```

### 5.4 Hybrid Retrieval Engine

The hybrid retriever combines vector similarity and graph traversal, with **cross-checking** to boost relevance:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HYBRID RETRIEVAL ALGORITHM                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User Query: "What happens if I upgrade HANA DB without updating FI?"       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 1: PARALLEL EXECUTION                                          │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                     │    │
│  │  Thread A (Vector)              Thread B (Graph)                    │    │
│  │  ┌─────────────────┐            ┌─────────────────┐                 │    │
│  │  │ COSINE_SIMILARITY│            │ Extract Entities│                 │    │
│  │  │ on query embed   │            │ "HANA DB", "FI" │                 │    │
│  │  └────────┬────────┘            └────────┬────────┘                 │    │
│  │           │                              │                          │    │
│  │           ▼                              ▼                          │    │
│  │  [Chunk A, Chunk B]             SPARQL: ?neighbor of entities       │    │
│  │                                          │                          │    │
│  │                                          ▼                          │    │
│  │                                 [Fact X, Fact Y, Fact Z]            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 2: CROSS-CHECK (The "Secret Sauce")                            │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                     │    │
│  │  For each Chunk:                                                    │    │
│  │    - Check hkv:sourceChunkID links                                  │    │
│  │    - Does Chunk A link to Fact X? → BOOST Chunk A score             │    │
│  │    - Does Chunk B link to Fact Y? → BOOST Chunk B score             │    │
│  │                                                                     │    │
│  │  Fusion Strategy: Reciprocal Rank Fusion (RRF)                      │    │
│  │    score = Σ (1 / (k + rank_vector)) + (1 / (k + rank_graph))       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ STEP 3: CONTEXT ASSEMBLY                                            │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                     │    │
│  │  Prompt = """                                                       │    │
│  │    Context (Text):                                                  │    │
│  │    {Chunk A text}                                                   │    │
│  │    {Chunk B text}                                                   │    │
│  │                                                                     │    │
│  │    Structured Facts (Graph):                                        │    │
│  │    - HANA_DB --[REQUIRES]--> FI_Module                              │    │
│  │    - FI_Module --[DEPENDS_ON]--> Config_X                           │    │
│  │                                                                     │    │
│  │    Question: {user question}                                        │    │
│  │  """                                                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**API Usage:**

```typescript
// Simple query
const response = await hkv.query({
  spaceId: "sap-s4hana",
  question: "What configuration is required for the Financial Module?",
});

console.log(response.answer);
console.log(response.sources);  // Source chunks and graph paths

// Advanced hybrid retrieval with full control
const response = await hkv.query({
  spaceId: "sap-s4hana",
  question: "What happens if I upgrade HANA DB without updating the FI module?",
  
  retrieval: {
    vector: {
      enabled: true,
      topK: 10,
      minScore: 0.7,
    },
    graph: {
      enabled: true,
      pathDepth: 2,              // Traverse 2 hops from matched entities
      maxPaths: 50,
    },
    fusion: "reciprocal_rank",   // or "linear", "max"
    crossCheck: true,            // Enable provenance boost
  },
  
  generation: {
    model: "claude-3-5-sonnet",
    maxTokens: 1000,
    includeReferences: true,
  }
});
```

### 5.5 Direct Graph Access

```typescript
// Execute SPARQL query
const results = await hkv.sparql({
  spaceId: "finance-contracts",
  query: `
    SELECT ?contract ?party ?obligation
    WHERE {
      ?contract a hkv:CONTRACT ;
                hkv:SIGNED_BY ?party ;
                hkv:OBLIGATES ?obligation .
      ?obligation hkv:HAS_VALUE ?amount .
      FILTER (?amount > 1000000)
    }
  `
});

// Get entity with relations
const entity = await hkv.getEntity({
  spaceId: "sap-s4hana",
  entityId: "entity_tcode_se80",
  includeRelations: true,
  depth: 1,
});

// Find paths between entities
const paths = await hkv.findPaths({
  spaceId: "sap-s4hana",
  fromEntity: "entity_module_fi",
  toEntity: "entity_module_co",
  maxDepth: 3,
});
```

---

## 6. Implementation Phases

### Phase 1: Foundation (Weeks 1-4)

| Component | Deliverable |
|-----------|-------------|
| Project Setup | TypeScript project, build tooling, testing framework |
| HANA Connector | Connection management, vector table operations, SPARQL execution |
| LiteLLM Integration | Proxy configuration, client wrapper, model routing |
| Space Manager | CRUD operations, schema validation, isolation enforcement |

### Phase 2: Ingestion Pipeline (Weeks 5-8)

| Component | Deliverable |
|-----------|-------------|
| Document Loaders | PDF, Markdown, HTML, plain text support |
| Chunking Strategies | Fixed-size, sentence-based, semantic chunking |
| Entity Extraction | Schema-guided and dynamic extraction via LlamaIndex |
| Triple Generation | RDF serialization, batch loading to HANA KG |
| Vector Generation | Embedding generation, HANA vector storage |

### Phase 3: Retrieval Engine (Weeks 9-12)

| Component | Deliverable |
|-----------|-------------|
| Vector Retriever | HANA vector similarity search integration |
| Graph Retriever | SPARQL-based entity and path retrieval |
| Hybrid Fusion | Multiple fusion strategies (RRF, linear, max) |
| Query Engine | Natural language to hybrid retrieval pipeline |
| Response Generation | Context assembly, LLM generation, citation |

### Phase 4: Production Readiness (Weeks 13-16)

| Component | Deliverable |
|-----------|-------------|
| Error Handling | Comprehensive error types, retry logic, circuit breakers |
| Observability | Logging, metrics, tracing integration |
| Performance | Connection pooling, batch operations, caching |
| Documentation | API docs, tutorials, deployment guides |
| Testing | Unit tests, integration tests, load tests |

---

## 7. Technology Stack

| Layer | Technology | Justification |
|-------|------------|---------------|
| **Runtime** | Node.js 20+ | LTS, TypeScript support, async performance |
| **Language** | TypeScript 5.x | Type safety, IDE support, maintainability |
| **LLM Orchestration** | LlamaIndex.TS + Custom | Base utilities from LlamaIndex.TS; custom `HanaPropertyGraphStore` |
| **LLM Gateway** | LiteLLM Proxy | Provider agnosticism, OpenAI SDK compatibility, cost tracking |
| **Database** | SAP HANA Cloud | Native RDF + Vector, enterprise grade, SQL interoperability |
| **HANA Driver** | `@sap/hana-client` | Native driver for NCLOB and REAL_VECTOR types (not generic ODBC) |
| **Schema Validation** | Zod | Runtime type validation, OpenAI structured output compatibility |
| **Testing** | Vitest | Fast, TypeScript-native, compatible with Jest |
| **Build** | tsup / esbuild | Fast bundling, ESM + CJS output |
| **Package Manager** | pnpm | Efficient disk usage, workspace support |
| **Deployment Target** | SAP BTP (Cloud Foundry / Kyma) | Standard BTP architecture for Node.js apps |

---

## 8. Security Considerations

### 8.1 Data Isolation

- **Space-level isolation**: Each Space uses separate named graphs and vector tables
- **Query scoping**: All queries automatically scoped to authorized Spaces
- **No cross-space joins**: Prevented at the query layer

### 8.2 Row-Level Security (RLS) - Roadmap

For production deployments where multiple Spaces share a HANA instance:

| Mechanism | Description |
|-----------|-------------|
| **HANA Analytic Privileges** | Define data access based on Space membership |
| **Row-Level Security** | Ensure queries for "Trucks" can never touch "Medical" data even with malformed SQL |
| **Implementation** | Phase 4 deliverable - integrate with SAP BTP Identity Services |

```sql
-- Example: Analytic Privilege for Space isolation
CREATE ANALYTIC PRIVILEGE "AP_SPACE_FINANCE" FOR SELECT ON "VECTORS_FINANCE_CONTRACTS"
  RESTRICTION ("SPACE_ID" = 'finance-contracts');

GRANT "AP_SPACE_FINANCE" TO "FINANCE_USERS_ROLE";
```

### 8.3 Credential Management

- HANA credentials via environment variables or SAP BTP Credential Store
- LiteLLM API keys managed per-model in proxy configuration
- Support for SAP AI Core integration (GenAI Hub) for enterprise deployments
- Service bindings for Cloud Foundry / Kyma deployments

### 8.4 Data Privacy

- No document content sent to LLMs beyond extraction/generation
- Option to use HANA's internal `VECTOR_EMBEDDING()` for data residency requirements
- Audit logging for all data access operations
- PII detection hooks (optional) during ingestion

---

## 9. Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **Ingestion throughput** | 100 pages/minute | With 4 parallel workers |
| **Vector search latency** | < 100ms p95 | For 1M vectors with HNSW index |
| **Graph traversal latency** | < 200ms p95 | 2-hop traversal, 10K triples |
| **End-to-end query latency** | < 3s p95 | Including LLM generation |
| **Concurrent queries** | 50 QPS | Per Space |

---

## 10. Technical Decisions (Resolved)

### 10.1 LlamaIndex.TS PropertyGraphIndex

| Aspect | Decision |
|--------|----------|
| **Risk** | High - TypeScript version lags behind Python; PropertyGraphIndex is newer feature |
| **Verdict** | Do not wait for official support |
| **Solution** | Implement custom `HanaPropertyGraphStore` class extending base `GraphStore` interface in Phase 1. Write node/edge extraction logic ourselves rather than relying on pre-built TS class. |

### 10.2 HANA Cloud SPARQL Connector

| Aspect | Decision |
|--------|----------|
| **Risk** | Must build - no off-the-shelf Node.js adapter for LlamaIndex → HANA SPARQL |
| **Verdict** | Use SQL wrapper approach |
| **Solution** | Use `SPARQL_EXECUTE()` via `@sap/hana-client` Node.js driver. More performant than HTTP REST API overhead. |

```typescript
// Example: SPARQL via SQL wrapper
import hana from "@sap/hana-client";

async function executeSparql(conn: hana.Connection, sparql: string, graphName: string) {
  const stmt = conn.prepare("CALL SPARQL_EXECUTE(?, ?, ?, ?)");
  const result = await stmt.exec([sparql, `rqx-default-graph-uri: ${graphName}`, "", null]);
  return parseSparqlXmlResult(result);
}
```

### 10.3 HANA Vector Store Integration

| Aspect | Decision |
|--------|----------|
| **Risk** | Low - logic is straightforward |
| **Verdict** | Build custom `HanaVectorStore` class |
| **Solution** | Port LangChain's `HanaDB` implementation. Core operations: `INSERT INTO ... (embedding)` and `SELECT ... COSINE_SIMILARITY()`. Do not depend on library having it built-in. |

```typescript
// Example: Custom HanaVectorStore
class HanaVectorStore implements VectorStore {
  async addDocuments(docs: Document[], embeddings: number[][]): Promise<string[]> {
    const stmt = this.conn.prepare(`
      INSERT INTO ${this.tableName} (id, space_id, content, content_hash, embedding)
      VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?))
    `);
    // ... batch insert logic
  }

  async similaritySearch(query: number[], k: number): Promise<Document[]> {
    const sql = `
      SELECT id, content, COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS score
      FROM ${this.tableName}
      WHERE space_id = ?
      ORDER BY score DESC
      LIMIT ?
    `;
    // ... execute and return
  }
}
```

### 10.4 LiteLLM TypeScript Client

| Aspect | Decision |
|--------|----------|
| **Risk** | Non-issue |
| **Verdict** | Use standard OpenAI Node.js SDK |
| **Solution** | Change `baseURL` to point to LiteLLM Proxy. Code thinks it's talking to OpenAI - that's the beauty of LiteLLM. All features (embeddings, function calling, streaming) work through proxy. |

```typescript
import OpenAI from "openai";

const llm = new OpenAI({
  apiKey: "any-key",  // LiteLLM handles actual auth
  baseURL: process.env.LITELLM_PROXY_URL ?? "http://localhost:4000"
});

// Works exactly like OpenAI SDK
const embedding = await llm.embeddings.create({
  model: "text-embedding-3-small",
  input: "Hello world"
});
```

### 10.5 Embedding Strategy

| Aspect | Decision |
|--------|----------|
| **Verdict** | External embeddings via LiteLLM |
| **Rationale** | SAP HANA's internal embedding models are generic. For specialized docs (SAP configs, Medical), models like `text-embedding-3-small` or Cohere models (via LiteLLM) outperform internal DB models. Also offloads CPU from HANA instance. |
| **Exception** | Use HANA's `VECTOR_EMBEDDING()` only when data residency requirements prohibit external API calls. |

---

## 11. Product Decisions (Resolved)

### 11.1 Ontology Management

| Aspect | Decision |
|--------|----------|
| **Default Mode** | Schema-Guided (Strict) for technical documentation |
| **Rationale** | Prevents LLM hallucinations like "Module A loves Module B" which break graph integrity |
| **Feature** | "Schema Suggestion Mode" - Run sample ingestion in dynamic mode, let LLM guess schema, output as JSON for human approval before production use |

```typescript
// Schema suggestion workflow
const suggestedSchema = await hkv.suggestSchema({
  spaceId: "new-space",
  sampleDocuments: ["./samples/doc1.pdf", "./samples/doc2.pdf"],
  sampleSize: 10,
});

console.log(JSON.stringify(suggestedSchema, null, 2));
// Human reviews and approves → becomes strict schema
```

### 11.2 Incremental Updates

| Aspect | Decision |
|--------|----------|
| **Strategy** | Content-hash based deduplication |
| **Implementation** | Store MD5 hash of chunk text in HANA. On re-ingestion, skip LLM extraction if hash unchanged. |
| **Benefit** | Massive cost savings on re-ingestion of unchanged content |

```typescript
interface DocumentChunk {
  id: string;
  content: string;
  contentHash: string;  // MD5 of content
  embedding?: number[];
  // ...
}

// During ingestion
const hash = crypto.createHash("md5").update(chunk.content).digest("hex");
const existing = await db.query("SELECT id FROM chunks WHERE content_hash = ?", [hash]);
if (existing.length > 0) {
  // Skip extraction - chunk already processed
  return existing[0].id;
}
```

### 11.3 Cross-Space Queries

| Aspect | Decision |
|--------|----------|
| **v1 Scope** | Not supported - strict Space isolation |
| **Future** | Consider federated queries with explicit opt-in per Space |

### 11.4 Remaining Open Questions

1. **Version History**: Deferred to v2 - evaluate need based on user feedback
2. **Access Control**: Start with Space-level permissions; entity-level deferred to v2
3. **Graph Node Embeddings**: Default OFF to save storage; configurable per Space

---

## 12. Success Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Retrieval Precision** | Relevant results / Total results | > 80% |
| **Retrieval Recall** | Relevant results found / Total relevant | > 70% |
| **Answer Faithfulness** | Answers grounded in retrieved context | > 95% |
| **Ingestion Success Rate** | Documents processed without error | > 99% |
| **Developer Adoption** | Weekly active Space creations | 50+ (6 months) |

---

## 13. Next Steps / Action Items

### 13.1 Phase 0: Validation (Before Implementation)

| # | Action | Owner | Deliverable |
|---|--------|-------|-------------|
| 1 | **Validate LlamaIndex.TS** | Dev | Write 50-line "Hello World" script attempting to import `PropertyGraphIndex`. Document what exists vs. what must be built. |
| 2 | **HANA Cloud Setup** | DevOps | Provision HANA Cloud instance with Triple Store enabled (8+ vCPUs). Verify SPARQL_EXECUTE works. |
| 3 | **LiteLLM Proxy POC** | Dev | Deploy LiteLLM proxy, confirm embeddings and chat completions work via OpenAI SDK. |

```typescript
// Phase 0 validation script
import { PropertyGraphIndex } from "llamaindex";  // Does this exist?

async function validateLlamaIndexTS() {
  try {
    // Attempt to use PropertyGraphIndex
    const index = new PropertyGraphIndex({ /* ... */ });
    console.log("✅ PropertyGraphIndex available in LlamaIndex.TS");
  } catch (e) {
    console.log("❌ PropertyGraphIndex NOT available - must build custom");
    // Add "Phase 0.5: Port PropertyGraphIndex" to roadmap
  }
}
```

### 13.2 Revised Implementation Phases

Based on resolved decisions, updated phase structure:

| Phase | Duration | Focus | Key Deliverables |
|-------|----------|-------|------------------|
| **0** | 1 week | Validation | Confirm LlamaIndex.TS capabilities, HANA setup |
| **1** | 4 weeks | Foundation | `HanaVectorStore`, `HanaSparqlStore`, `SpaceManager`, Zod schemas |
| **2** | 4 weeks | Ingestion | Pipeline with provenance linking, hash-based deduplication |
| **3** | 4 weeks | Retrieval | Hybrid retriever with cross-check, RRF fusion |
| **4** | 3 weeks | Production | RLS integration, observability, documentation |

### 13.3 Acceptance Criteria for Phase 1 Complete

- [ ] `HanaVectorStore` passes unit tests (add/search documents)
- [ ] `HanaSparqlStore` executes SPARQL via SQL wrapper
- [ ] `SpaceManager` creates/lists/deletes Spaces with isolation
- [ ] Zod schemas validate extraction output
- [ ] Integration test: Ingest 1 PDF → query → get answer with sources

---

## 14. References

### SAP HANA Cloud Documentation
- [SAP HANA Cloud Vector Engine Guide](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide)
- [SAP HANA Cloud Knowledge Graph Engine](https://community.sap.com/t5/technology-blog-posts-by-sap/connecting-the-facts-sap-hana-cloud-s-knowledge-graph-engine-for-business/ba-p/13888597)
- [Semantic Querying with HANA KG and GenAI](https://community.sap.com/t5/technology-blog-posts-by-sap/semantic-querying-with-sap-hana-cloud-knowledge-graph-using-rdf-sparql-and/ba-p/14109200)
- [SAP Discovery Center - Knowledge Graph Mission](https://discovery-center.cloud.sap/missiondetail/4568/4856/)

### LlamaIndex Documentation
- [LlamaIndex.TS Documentation](https://ts.llamaindex.ai/)
- [Property Graph Index Guide](https://docs.llamaindex.ai/en/stable/module_guides/indexing/lpg_index_guide/)
- [Introducing PropertyGraphIndex](https://www.llamaindex.ai/blog/introducing-the-property-graph-index-a-powerful-new-way-to-build-knowledge-graphs-with-llms)

### LiteLLM Documentation
- [LiteLLM Documentation](https://docs.litellm.ai/)
- [LiteLLM Proxy Server](https://docs.litellm.ai/docs/proxy_server)

### Research Papers
- [HybridRAG: Integrating Knowledge Graphs and Vector Retrieval](https://arxiv.org/html/2408.04948v1)
- [Microsoft GraphRAG](https://github.com/microsoft/graphrag)

---

## Appendix A: Example Ontology - SAP S/4HANA (Zod)

```typescript
import { z } from "zod";

// SAP S/4HANA Domain Schema
const SapEntityType = z.enum([
  "MODULE",
  "TCODE", 
  "CONFIG_PARAM",
  "TABLE",
  "BAPI",
  "ERROR",
  "AUTHORIZATION"
]);

const SapRelationType = z.enum([
  "REQUIRES",
  "DEPENDS_ON", 
  "INTEGRATES_WITH",
  "BELONGS_TO",
  "CALLS",
  "REQUIRES_AUTH",
  "CONFIGURES",
  "AFFECTS",
  "DEFAULT_VALUE",
  "STORES",
  "REFERENCES",
  "INDEXED_BY",
  "EXPOSED_BY",
  "RETURNS",
  "RAISED_BY",
  "RESOLVED_BY",
  "CAUSED_BY",
  "GRANTS_ACCESS",
  "REQUIRED_BY"
]);

// Validation schema mapping entity types to allowed relations
const sapS4HanaOntology = {
  schema: {
    "MODULE": ["REQUIRES", "DEPENDS_ON", "INTEGRATES_WITH"],
    "TCODE": ["BELONGS_TO", "CALLS", "REQUIRES_AUTH"],
    "CONFIG_PARAM": ["CONFIGURES", "AFFECTS", "DEFAULT_VALUE"],
    "TABLE": ["STORES", "REFERENCES", "INDEXED_BY"],
    "BAPI": ["EXPOSED_BY", "CALLS", "RETURNS"],
    "ERROR": ["RAISED_BY", "RESOLVED_BY", "CAUSED_BY"],
    "AUTHORIZATION": ["GRANTS_ACCESS", "REQUIRED_BY"],
  } as const,
  strictValidation: true
};

// Create Space with Zod schema
const sapSpace = await hkv.spaces.create({
  id: "sap-s4hana",
  name: "SAP S/4HANA Capabilities",
  schema: {
    entityTypes: SapEntityType,
    relationTypes: SapRelationType,
    validationSchema: sapS4HanaOntology.schema,
  },
  strictValidation: true
});
```

## Appendix B: Example SPARQL Queries

```sparql
# Find all modules that depend on a specific configuration
PREFIX hkv: <urn:hana-kgvector:>
PREFIX space: <urn:hana-kgvector:sap-s4hana:>

SELECT ?module ?config ?description
WHERE {
  ?module a hkv:MODULE ;
          hkv:REQUIRES ?config .
  ?config a hkv:CONFIG_PARAM ;
          hkv:name ?description .
  FILTER (CONTAINS(?description, "HANA"))
}
ORDER BY ?module
```

```sparql
# Find error resolution paths
PREFIX hkv: <urn:hana-kgvector:>

SELECT ?error ?resolution ?relatedConfig
WHERE {
  ?error a hkv:ERROR ;
         hkv:RESOLVED_BY ?resolution .
  OPTIONAL {
    ?error hkv:CAUSED_BY ?relatedConfig .
    ?relatedConfig a hkv:CONFIG_PARAM .
  }
}
```
