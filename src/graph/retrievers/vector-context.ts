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

    // Partition vector results into document nodes and entity/other nodes
    const entityNodes: LabelledNode[] = [];
    const entityScores: number[] = [];
    const documentResults: NodeWithScore[] = [];

    for (let i = 0; i < kgNodes.length; i++) {
      const node = kgNodes[i];
      if (node.label === "DOCUMENT") {
        // Document nodes are direct results — they don't need graph traversal.
        // Use node.id as refDocId so addSourceText() can fetch full text from _NODES.
        documentResults.push({
          node: {
            id: node.id,
            text: `Document: ${node.name}`,
            metadata: node.properties ?? {},
            refDocId: node.id,
          },
          score: scores[i],
        });
      } else {
        entityNodes.push(node);
        entityScores.push(scores[i]);
      }
    }

    // --- Entity flow: graph traversal to find triplets ---
    let tripletResults: NodeWithScore[] = [];

    if (entityNodes.length > 0) {
      const kgIds = entityNodes.map((n) => n.id);

      // Build provenance set from vector-matched nodes for cross-check boosting
      const provenanceSet = new Set<string>();
      if (this.crossCheckBoost) {
        for (const node of entityNodes) {
          provenanceSet.add(node.id.toLowerCase());
          provenanceSet.add(node.name.toLowerCase());

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
        nodes: entityNodes,
        depth: this.pathDepth,
        limit: this.limit,
        ignoreRels: [KG_SOURCE_REL],
      });

      // Structural expansion: traverse ON_SAME_PAGE, ADJACENT_TO edges from source chunks
      if (this.includeStructuralEdges) {
        const chunkIds = new Set<string>();
        for (const node of entityNodes) {
          const sourceId = node.properties?.[TRIPLET_SOURCE_KEY];
          if (sourceId) {
            chunkIds.add(`CHUNK_${String(sourceId).replace(/\s+/g, "_").toUpperCase()}`);
          }
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

            const structuralRels = [STRUCT_SAME_PAGE, STRUCT_ADJACENT, STRUCT_CONTAINS];
            const structuralOnly = structuralTriplets.filter(([_s, r, _o]) =>
              structuralRels.includes(r.label)
            );

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
        const score1 = idx1 >= 0 ? entityScores[idx1] : 0;
        const score2 = idx2 >= 0 ? entityScores[idx2] : 0;
        let baseScore = Math.max(score1, score2);

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

      tripletResults = this.getNodesWithScore(
        results.map((r) => r.triplet),
        results.map((r) => r.score)
      );
    }

    // --- Merge document results and triplet results, sorted by score ---
    const allResults = [...documentResults, ...tripletResults];

    if (this.similarityScore !== undefined) {
      return allResults
        .filter((r) => r.score >= this.similarityScore!)
        .sort((a, b) => b.score - a.score);
    }

    return allResults.sort((a, b) => b.score - a.score);
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
