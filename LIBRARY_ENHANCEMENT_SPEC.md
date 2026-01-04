# hana-kgvector Library Enhancement: Structural Adjacency Links

## Overview

This document specifies changes to the `hana-kgvector` library to support **structural adjacency edges** between document chunks. This enables multimodal content (images, tables, code blocks) to be retrieved via graph traversal when nearby text is matched, without requiring direct node-table vector search.

---

## Problem Statement

Currently:
1. **KG extraction** produces entities/relations from chunk text
2. **Vector search** only queries the `*_VECTORS` table (KG entity embeddings)
3. **Graph expansion** traverses entity relationships

Image description chunks go through KG extraction, but if the VLM description doesn't produce entities that overlap with nearby text entities, the image chunk becomes unreachable during retrieval.

**Goal:** Create structural graph edges that link chunks based on document position (same page, adjacent chunks), so graph traversal naturally includes related multimodal content.

---

## Design Principles

1. **General-purpose** — Not image-specific; works for any chunk type
2. **Opt-in** — Enabled via configuration, not forced
3. **Minimal schema impact** — Uses existing graph infrastructure
4. **Retrieval-compatible** — Works with existing `VectorContextRetriever` expansion

---

## Implementation Plan

### Phase 1: New Structural Relation Types

Add constants for structural relations in `src/graph/types.ts`:

```typescript
// Structural adjacency relations (not semantic)
export const STRUCT_SAME_PAGE = "ON_SAME_PAGE";
export const STRUCT_ADJACENT = "ADJACENT_TO";
export const STRUCT_CONTAINS = "CONTAINS";  // e.g., page contains image
```

### Phase 2: Adjacency Linker (New Extractor)

Create `src/graph/extractors/adjacency-linker.ts`:

```typescript
import { createEntityNode, createRelation, KG_NODES_KEY, KG_RELATIONS_KEY, STRUCT_SAME_PAGE, STRUCT_ADJACENT } from "../types.js";

export interface AdjacencyLinkerOptions {
  /**
   * Link chunks that share the same pageNumber in metadata.
   * Default: true
   */
  linkSamePage?: boolean;

  /**
   * Link chunks that are adjacent by chunkIndex in metadata.
   * Default: true
   */
  linkAdjacent?: boolean;

  /**
   * Maximum chunk index distance for ADJACENT_TO links.
   * Default: 1 (immediate neighbors only)
   */
  adjacentDistance?: number;

  /**
   * Only create cross-type links (e.g., text↔image), not text↔text.
   * Default: false (link all)
   */
  crossTypeOnly?: boolean;
}

interface NodeInput {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  hash?: string;
}

export class AdjacencyLinker {
  private linkSamePage: boolean;
  private linkAdjacent: boolean;
  private adjacentDistance: number;
  private crossTypeOnly: boolean;

  constructor(options: AdjacencyLinkerOptions = {}) {
    this.linkSamePage = options.linkSamePage ?? true;
    this.linkAdjacent = options.linkAdjacent ?? true;
    this.adjacentDistance = options.adjacentDistance ?? 1;
    this.crossTypeOnly = options.crossTypeOnly ?? false;
  }

  /**
   * Transform is called AFTER other extractors (SchemaLLMPathExtractor, ImplicitPathExtractor).
   * It adds structural relations between chunks based on metadata.
   */
  async transform(nodes: NodeInput[], options?: { showProgress?: boolean }): Promise<NodeInput[]> {
    if (nodes.length < 2) return nodes;

    // Group nodes by documentId
    const byDocument = new Map<string, NodeInput[]>();
    for (const node of nodes) {
      const docId = String(node.metadata.documentId ?? "unknown");
      if (!byDocument.has(docId)) byDocument.set(docId, []);
      byDocument.get(docId)!.push(node);
    }

    // For each document, create structural links
    const nodeRelationsMap = new Map<string, Array<{ label: string; sourceId: string; targetId: string; properties: Record<string, unknown> }>>();

    for (const [docId, docNodes] of byDocument) {
      // Group by page
      const byPage = new Map<number, NodeInput[]>();
      for (const node of docNodes) {
        const page = Number(node.metadata.pageNumber ?? 0);
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(node);
      }

      // Same-page links
      if (this.linkSamePage) {
        for (const [page, pageNodes] of byPage) {
          if (pageNodes.length < 2) continue;
          for (let i = 0; i < pageNodes.length; i++) {
            for (let j = i + 1; j < pageNodes.length; j++) {
              const a = pageNodes[i];
              const b = pageNodes[j];
              if (this.shouldLink(a, b)) {
                this.addRelation(nodeRelationsMap, a.id, b.id, STRUCT_SAME_PAGE, { pageNumber: page, documentId: docId });
              }
            }
          }
        }
      }

      // Adjacent chunk links (by chunkIndex)
      if (this.linkAdjacent) {
        // Sort by chunkIndex
        const sorted = [...docNodes].sort((a, b) => {
          const idxA = Number(a.metadata.chunkIndex ?? 0);
          const idxB = Number(b.metadata.chunkIndex ?? 0);
          return idxA - idxB;
        });

        for (let i = 0; i < sorted.length; i++) {
          for (let d = 1; d <= this.adjacentDistance && i + d < sorted.length; d++) {
            const a = sorted[i];
            const b = sorted[i + d];
            if (this.shouldLink(a, b)) {
              this.addRelation(nodeRelationsMap, a.id, b.id, STRUCT_ADJACENT, { distance: d, documentId: docId });
            }
          }
        }
      }
    }

    // Merge relations into node metadata
    return nodes.map(node => {
      const existingRelations = (node.metadata[KG_RELATIONS_KEY] as any[]) ?? [];
      const newRelations = nodeRelationsMap.get(node.id) ?? [];
      
      // Also need to ensure CHUNK nodes exist for structural links to work
      // The ImplicitPathExtractor already creates CHUNK nodes, so we just add relations
      
      return {
        ...node,
        metadata: {
          ...node.metadata,
          [KG_RELATIONS_KEY]: [...existingRelations, ...newRelations],
        },
      };
    });
  }

  private shouldLink(a: NodeInput, b: NodeInput): boolean {
    if (!this.crossTypeOnly) return true;
    const typeA = String(a.metadata.contentType ?? "text");
    const typeB = String(b.metadata.contentType ?? "text");
    return typeA !== typeB;
  }

  private addRelation(
    map: Map<string, Array<{ label: string; sourceId: string; targetId: string; properties: Record<string, unknown> }>>,
    sourceNodeId: string,
    targetNodeId: string,
    label: string,
    properties: Record<string, unknown>
  ) {
    // Create CHUNK entity IDs (matching ImplicitPathExtractor format)
    const sourceId = `CHUNK_${sourceNodeId.replace(/\s+/g, "_").toUpperCase()}`;
    const targetId = `CHUNK_${targetNodeId.replace(/\s+/g, "_").toUpperCase()}`;

    const rel = {
      label,
      sourceId,
      targetId,
      properties,
    };

    // Add to source node
    if (!map.has(sourceNodeId)) map.set(sourceNodeId, []);
    map.get(sourceNodeId)!.push(rel);

    // Bidirectional: also add reverse
    if (!map.has(targetNodeId)) map.set(targetNodeId, []);
    map.get(targetNodeId)!.push({
      ...rel,
      sourceId: targetId,
      targetId: sourceId,
    });
  }
}
```

### Phase 3: Update VectorContextRetriever

Modify `src/graph/retrievers/vector-context.ts` to optionally traverse structural edges:

```typescript
export interface VectorContextRetrieverOptions extends BasePGRetrieverOptions {
  // ... existing options ...

  /**
   * Include structural adjacency relations (ON_SAME_PAGE, ADJACENT_TO) in graph expansion.
   * Default: true
   */
  includeStructuralEdges?: boolean;

  /**
   * Depth for structural edge traversal (separate from semantic pathDepth).
   * Default: 1
   */
  structuralDepth?: number;
}
```

In `retrieveFromGraph`, after the main `getRelMap` call:

```typescript
// Existing semantic expansion
const triplets = await this.graphStore.getRelMap({
  nodes: kgNodes,
  depth: this.pathDepth,
  limit: this.limit,
  ignoreRels: [KG_SOURCE_REL],
});

// NEW: Structural expansion (if enabled)
if (this.includeStructuralEdges) {
  // Get CHUNK nodes linked to matched entities via TRIPLET_SOURCE_KEY
  const chunkIds = new Set<string>();
  for (const node of kgNodes) {
    const sourceId = node.properties?.[TRIPLET_SOURCE_KEY];
    if (sourceId) {
      chunkIds.add(`CHUNK_${String(sourceId).replace(/\s+/g, "_").toUpperCase()}`);
    }
  }

  if (chunkIds.size > 0) {
    const chunkNodes = await this.graphStore.get({ ids: Array.from(chunkIds) });
    const structuralTriplets = await this.graphStore.getRelMap({
      nodes: chunkNodes,
      depth: this.structuralDepth ?? 1,
      limit: this.limit,
      ignoreRels: [KG_SOURCE_REL], // Keep structural rels
    });

    // Filter to only structural relations
    const structuralOnly = structuralTriplets.filter(([s, r, o]) =>
      [STRUCT_SAME_PAGE, STRUCT_ADJACENT, STRUCT_CONTAINS].includes(r.label)
    );

    triplets.push(...structuralOnly);
  }
}
```

### Phase 4: Export New Components

Update `src/index.ts`:

```typescript
export { AdjacencyLinker, type AdjacencyLinkerOptions } from "./graph/extractors/adjacency-linker.js";
export { STRUCT_SAME_PAGE, STRUCT_ADJACENT, STRUCT_CONTAINS } from "./graph/types.js";
```

---

## Usage in multi-doc-chat

### upload-docs.ts Changes

```typescript
import {
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
  AdjacencyLinker,  // NEW
  // ...
} from "hana-kgvector";

// In index creation:
const index = new PropertyGraphIndex({
  propertyGraphStore: graphStore,
  embedModel,
  kgExtractors: [
    new SchemaLLMPathExtractor({
      llm: llmClient,
      schema,
      maxTripletsPerChunk: TRIPLETS_PER_CHUNK,
      strict: false,
    }),
    new ImplicitPathExtractor(),
    new AdjacencyLinker({           // NEW - must come AFTER ImplicitPathExtractor
      linkSamePage: true,
      linkAdjacent: true,
      adjacentDistance: 1,
      crossTypeOnly: false,         // Link all chunks, or set true for only text↔image
    }),
  ],
  embedKgNodes: true,
  showProgress: true,
});
```

### chat.ts Changes

```typescript
// In query options:
const results = await index.query(query, {
  similarityTopK: 10,
  pathDepth: 2,
  limit: 50,
  includeStructuralEdges: true,    // NEW
  structuralDepth: 1,              // NEW
});
```

### Metadata Requirements

For adjacency linking to work, chunks must have these metadata fields:
- `documentId` — groups chunks by document
- `pageNumber` — for same-page linking
- `chunkIndex` — for adjacent-chunk linking
- `contentType` — (optional) for cross-type-only mode ("text", "image", etc.)

The current `upload-docs.ts` already sets all of these ✓

---

## Graph Structure After Enhancement

```
                    ┌─────────────────┐
                    │  DOCUMENT node  │
                    │ (START_OP2025)  │
                    └────────┬────────┘
                             │ FROM_DOCUMENT
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ CHUNK_0  │   │ CHUNK_1  │   │ CHUNK_2  │
        │ (text)   │   │ (text)   │   │ (image)  │
        └────┬─────┘   └────┬─────┘   └────┬─────┘
             │              │              │
             │ ADJACENT_TO  │ ON_SAME_PAGE │
             └──────────────┼──────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        ┌──────────┐               ┌──────────┐
        │ PRODUCT  │───DESCRIBES──▶│ FEATURE  │
        │ S/4HANA  │               │ Migration│
        └──────────┘               └──────────┘
```

When a query matches "S/4HANA" or "Migration":
1. Vector search finds PRODUCT and FEATURE entities
2. Semantic expansion finds related entities
3. Source chunks (CHUNK_0, CHUNK_1) are retrieved via TRIPLET_SOURCE_KEY
4. **Structural expansion** follows ON_SAME_PAGE/ADJACENT_TO to CHUNK_2 (image)
5. Image chunk is included in results with its `imageId` metadata

---

## Retrieval Flow (After Enhancement)

```
User Query: "What is the S/4HANA migration process?"
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Embed query                                          │
│ 2. Vector search → VECTORS table → matched KG entities  │
│ 3. Semantic expansion → related entities via relations  │
│ 4. Get source chunks via TRIPLET_SOURCE_KEY             │
│ 5. NEW: Structural expansion → ON_SAME_PAGE, ADJACENT_TO│
│ 6. Fetch all chunk texts from NODES table               │
│ 7. Return ranked results (including image chunks)       │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
Results include:
- Text chunk about migration (direct match)
- Image chunk showing migration diagram (via structural link)
```

---

## Testing Checklist

- [ ] AdjacencyLinker creates ON_SAME_PAGE relations for chunks on same page
- [ ] AdjacencyLinker creates ADJACENT_TO relations for sequential chunks
- [ ] crossTypeOnly=true only links text↔image, not text↔text
- [ ] VectorContextRetriever traverses structural edges when enabled
- [ ] Image chunks appear in results when nearby text matches query
- [ ] No performance regression for queries without structural edges
- [ ] Existing tests still pass

---

## Migration Notes

- **Backward compatible** — New features are opt-in
- **Existing graphs** — Won't have structural edges; re-upload required to add them
- **No schema changes** — Uses existing RDF graph infrastructure

---

## Future Enhancements (Out of Scope)

1. **Node-table vector search** — Direct similarity search on `*_NODES.embedding` for chunk-level retrieval
2. **Weighted structural edges** — Different weights for same-page vs adjacent
3. **Cross-document links** — Link chunks across documents that share entities
4. **Temporal adjacency** — For time-series documents

---

## Summary

This enhancement adds **structural adjacency edges** to the knowledge graph, enabling multimodal content to be retrieved through graph traversal rather than requiring direct node-table queries. The design is general-purpose, opt-in, and backward compatible.

**Key components:**
1. `AdjacencyLinker` extractor — Creates structural relations during insert
2. `VectorContextRetriever` enhancement — Traverses structural edges during retrieval
3. New relation types — `ON_SAME_PAGE`, `ADJACENT_TO`, `CONTAINS`

**Result:** Images and other non-text chunks become reachable when nearby text matches a query, without changing the core retrieval algorithm.
