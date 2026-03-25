# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

hana-kgvector is a TypeScript framework for building hybrid GraphRAG applications using SAP HANA Cloud as the unified backend. It combines knowledge graphs (RDF via SPARQL) with vector embeddings (HANA Vector Engine) to enable retrieval-augmented generation that leverages both semantic similarity search and structured graph traversal.

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm run build            # Build with tsup (ESM output to dist/)
pnpm run dev              # Run src/index.ts with tsx

# Validation scripts (require .env.local with credentials)
pnpm run phase0:hana      # Validate HANA Cloud connection
pnpm run phase0:litellm   # Validate LiteLLM proxy connection
pnpm run smoke:pg         # Smoke test PropertyGraphIndex end-to-end

# Additional scripts run directly with tsx
pnpm exec tsx scripts/test-quality.ts     # Quality test suite
pnpm exec tsx scripts/list-graphs.ts      # List existing RDF graphs
pnpm exec tsx scripts/debug-vectors.ts    # Debug vector store contents
pnpm exec tsx scripts/debug-embedding-api.ts  # Debug embedding API
```

There is no automated test framework (no Jest/Vitest). Testing is done via the `scripts/` directory which contains integration validation scripts that require live HANA and LiteLLM connections.

## Environment Setup

Copy `.env.example` to `.env.local` with these variables:
- `HANA_HOST`, `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD` - SAP HANA Cloud connection
- `LITELLM_PROXY_URL`, `LITELLM_API_KEY` - LiteLLM proxy (OpenAI-compatible endpoint)
- `DEFAULT_LLM_MODEL`, `DEFAULT_EMBEDDING_MODEL` - Model names for extraction and embedding

## Architecture

### Module Layout

- **`src/graph/`** - Core graph functionality (the main library)
  - `property-graph-index.ts` - **Primary entry point**: `PropertyGraphIndex` orchestrates insert and query operations
  - `property-graph-store.ts` - `PropertyGraphStore` interface defining the backend contract
  - `hana-property-graph-store.ts` - SAP HANA implementation using SPARQL for RDF and COSINE_SIMILARITY for vectors
  - `pg-retriever.ts` - `PGRetriever` orchestrates multiple sub-retrievers
  - `types.ts` - Core domain types: `EntityNode`, `Relation`, `Triplet`, `NodeWithScore`, `QueryBundle`
  - `extractors/` - Pipeline components implementing `TransformComponent` for entity/relation extraction
  - `retrievers/` - Query strategies including `VectorContextRetriever` (vector search + graph traversal)

- **`src/hana/`** - HANA connectivity layer
  - `connection.ts` - `createHanaConnection()` factory and `hanaExec<T>()` typed SQL wrapper
  - `sparql-store.ts` - Direct `HanaSparqlStore` for raw SPARQL queries
  - `graph-discovery.ts` - Utilities to list and inspect existing RDF graphs in a HANA schema

### Data Flow

**Insert**: `PropertyGraphIndex.insert(nodes)` runs nodes through extractor pipeline (SchemaLLMPathExtractor -> ImplicitPathExtractor -> AdjacencyLinker), generates embeddings, then stores entities as RDF triples via SPARQL and embeddings in a HANA vector table.

**Query**: `PropertyGraphIndex.query(text)` embeds the query, performs COSINE_SIMILARITY vector search on HANA, retrieves top-K entity nodes, then expands via graph traversal (SPARQL) up to configurable `pathDepth` hops. Results are ranked with optional cross-check boosting when vector-matched entities share document provenance.

### Key Design Patterns

- **Interface-based extensibility**: `PropertyGraphStore` interface allows alternative backends beyond HANA
- **Composable extractor pipeline**: Extractors implement `TransformComponent` and are chained in sequence
- **Dual storage**: RDF named graphs (via `SPARQL_EXECUTE` stored procedure) for structured relationships + column tables with `REAL_VECTOR` columns for embeddings
- **Multi-tenancy**: Each `graphName` creates isolated RDF graphs and vector/document tables
- **LLM-agnostic**: Uses OpenAI SDK client interface; works with any model via LiteLLM proxy

### Build Configuration

- ESM-only output (no CJS), target ES2022, strict TypeScript
- `@sap/hana-client` is an **optional dependency** - externalized from the bundle
- Built with tsup; declarations generated with source maps
- Zod schemas validate core types (`EntityNodeSchema`, `RelationSchema`)
