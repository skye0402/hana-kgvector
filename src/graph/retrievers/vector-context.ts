import type { PropertyGraphStore, VectorStoreQuery } from "../property-graph-store";
import type { QueryBundle, NodeWithScore, LabelledNode } from "../types";
import { KG_SOURCE_REL, TRIPLET_SOURCE_KEY, STRUCT_SAME_PAGE, STRUCT_ADJACENT, STRUCT_CONTAINS } from "../types";
import { BasePGRetriever, type BasePGRetrieverOptions } from "./base";

export interface EmbedModel {
  getTextEmbedding(text: string): Promise<number[]>;
  getTextEmbeddingBatch(texts: string[]): Promise<number[][]>;
}

export interface VectorContextRetrieverOptions extends BasePGRetrieverOptions {
  embedModel: EmbedModel;
  similarityTopK?: number;
  pathDepth?: number;
  limit?: number;
  similarityScore?: number;
  /** Enable cross-check boosting: boost scores when vector-matched entities link to graph facts (default: true) */
  crossCheckBoost?: boolean;
  /** Multiplier for cross-check boost (default: 1.25 = 25% boost) */
  crossCheckBoostFactor?: number;
  /** Include structural adjacency relations (ON_SAME_PAGE, ADJACENT_TO) in graph expansion (default: true) */
  includeStructuralEdges?: boolean;
  /** Depth for structural edge traversal (default: 1) */
  structuralDepth?: number;
}

export class VectorContextRetriever extends BasePGRetriever {
  private readonly embedModel: EmbedModel;
  private readonly similarityTopK: number;
  private readonly pathDepth: number;
  private readonly limit: number;
  private readonly similarityScore?: number;
  private readonly crossCheckBoost: boolean;
  private readonly crossCheckBoostFactor: number;
  private readonly includeStructuralEdges: boolean;
  private readonly structuralDepth: number;

  constructor(options: VectorContextRetrieverOptions) {
    super(options);
    this.embedModel = options.embedModel;
    this.similarityTopK = options.similarityTopK ?? 4;
    this.pathDepth = options.pathDepth ?? 1;
    this.limit = options.limit ?? 30;
    this.similarityScore = options.similarityScore;
    this.crossCheckBoost = options.crossCheckBoost ?? true;
    this.crossCheckBoostFactor = options.crossCheckBoostFactor ?? 1.25;
    this.includeStructuralEdges = options.includeStructuralEdges ?? true;
    this.structuralDepth = options.structuralDepth ?? 1;
  }

  async retrieveFromGraph(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    let embedding = queryBundle.embedding;

    if (!embedding) {
      embedding = await this.embedModel.getTextEmbedding(queryBundle.queryStr);
    }

    const vectorQuery: VectorStoreQuery = {
      queryEmbedding: embedding,
      similarityTopK: this.similarityTopK,
    };

    if (!this.graphStore.supportsVectorQueries || !this.graphStore.vectorQuery) {
      throw new Error("Graph store does not support vector queries");
    }

    const [kgNodes, scores] = await this.graphStore.vectorQuery(vectorQuery);

    if (kgNodes.length === 0) {
      return [];
    }

    const kgIds = kgNodes.map((n) => n.id);

    // Build provenance set from vector-matched nodes for cross-check boosting
    // This includes document IDs, chunk IDs, and other source identifiers
    const provenanceSet = new Set<string>();
    if (this.crossCheckBoost) {
      for (const node of kgNodes) {
        // Add node ID itself (for CHUNK nodes)
        provenanceSet.add(node.id.toLowerCase());
        provenanceSet.add(node.name.toLowerCase());
        
        // Add documentId from properties if present
        const props = node.properties ?? {};
        if (props.documentId) {
          provenanceSet.add(String(props.documentId).toLowerCase());
        }
        if (props.sourceChunk) {
          provenanceSet.add(String(props.sourceChunk).toLowerCase());
        }
      }
    }

    let triplets = await this.graphStore.getRelMap({
      nodes: kgNodes,
      depth: this.pathDepth,
      limit: this.limit,
      ignoreRels: [KG_SOURCE_REL],
    });

    // Structural expansion: traverse ON_SAME_PAGE, ADJACENT_TO edges from source chunks
    if (this.includeStructuralEdges) {
      // Get CHUNK node IDs linked to matched entities via TRIPLET_SOURCE_KEY
      const chunkIds = new Set<string>();
      for (const node of kgNodes) {
        const sourceId = node.properties?.[TRIPLET_SOURCE_KEY];
        if (sourceId) {
          chunkIds.add(`CHUNK_${String(sourceId).replace(/\s+/g, "_").toUpperCase()}`);
        }
        // Also include CHUNK nodes that were directly matched
        if (node.label === "CHUNK") {
          chunkIds.add(node.id);
        }
      }

      if (chunkIds.size > 0) {
        const chunkNodes = await this.graphStore.get({ ids: Array.from(chunkIds) });
        if (chunkNodes.length > 0) {
          const structuralTriplets = await this.graphStore.getRelMap({
            nodes: chunkNodes,
            depth: this.structuralDepth,
            limit: this.limit,
            ignoreRels: [KG_SOURCE_REL],
          });

          // Filter to only structural relations
          const structuralRels = [STRUCT_SAME_PAGE, STRUCT_ADJACENT, STRUCT_CONTAINS];
          const structuralOnly = structuralTriplets.filter(([_s, r, _o]) =>
            structuralRels.includes(r.label)
          );

          // Add structural triplets to results (avoid duplicates)
          const existingKeys = new Set(triplets.map(([s, r, o]) => `${s.id}|${r.label}|${o.id}`));
          for (const triplet of structuralOnly) {
            const key = `${triplet[0].id}|${triplet[1].label}|${triplet[2].id}`;
            if (!existingKeys.has(key)) {
              triplets.push(triplet);
              existingKeys.add(key);
            }
          }
        }
      }
    }

    const newScores: number[] = [];
    for (const triplet of triplets) {
      const idx1 = kgIds.indexOf(triplet[0].id);
      const idx2 = kgIds.indexOf(triplet[2].id);
      const score1 = idx1 >= 0 ? scores[idx1] : 0;
      const score2 = idx2 >= 0 ? scores[idx2] : 0;
      let baseScore = Math.max(score1, score2);

      // Cross-check boosting: if triplet entities have provenance linking back to
      // vector-matched nodes, boost the score. This rewards facts that are both
      // semantically similar AND have explicit graph connections.
      if (this.crossCheckBoost && baseScore > 0) {
        const shouldBoost = this.checkProvenance(triplet[0], provenanceSet) ||
                           this.checkProvenance(triplet[2], provenanceSet);
        if (shouldBoost) {
          baseScore = Math.min(1.0, baseScore * this.crossCheckBoostFactor);
        }
      }

      newScores.push(baseScore);
    }

    let results = triplets.map((t, i) => ({ triplet: t, score: newScores[i] }));

    if (this.similarityScore !== undefined) {
      results = results.filter((r) => r.score >= this.similarityScore!);
    }

    results.sort((a, b) => b.score - a.score);

    return this.getNodesWithScore(
      results.map((r) => r.triplet),
      results.map((r) => r.score)
    );
  }

  /**
   * Check if a node has provenance linking to the vector-matched nodes.
   * Returns true if the node's properties contain a documentId or sourceChunk
   * that matches something in the provenance set.
   */
  private checkProvenance(node: LabelledNode, provenanceSet: Set<string>): boolean {
    if (provenanceSet.size === 0) return false;

    const props = node.properties ?? {};
    
    // Check documentId property
    if (props.documentId && provenanceSet.has(String(props.documentId).toLowerCase())) {
      return true;
    }
    
    // Check sourceChunk property
    if (props.sourceChunk && provenanceSet.has(String(props.sourceChunk).toLowerCase())) {
      return true;
    }
    
    // Check if this node itself is in the provenance set (e.g., a CHUNK node)
    if (provenanceSet.has(node.id.toLowerCase()) || provenanceSet.has(node.name.toLowerCase())) {
      return true;
    }

    return false;
  }
}
