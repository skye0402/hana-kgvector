import type { PropertyGraphStore, VectorStoreQuery } from "../property-graph-store";
import type { QueryBundle, NodeWithScore, LabelledNode } from "../types";
import { KG_SOURCE_REL } from "../types";
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
}

export class VectorContextRetriever extends BasePGRetriever {
  private readonly embedModel: EmbedModel;
  private readonly similarityTopK: number;
  private readonly pathDepth: number;
  private readonly limit: number;
  private readonly similarityScore?: number;

  constructor(options: VectorContextRetrieverOptions) {
    super(options);
    this.embedModel = options.embedModel;
    this.similarityTopK = options.similarityTopK ?? 4;
    this.pathDepth = options.pathDepth ?? 1;
    this.limit = options.limit ?? 30;
    this.similarityScore = options.similarityScore;
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

    const triplets = await this.graphStore.getRelMap({
      nodes: kgNodes,
      depth: this.pathDepth,
      limit: this.limit,
      ignoreRels: [KG_SOURCE_REL],
    });

    const newScores: number[] = [];
    for (const triplet of triplets) {
      const idx1 = kgIds.indexOf(triplet[0].id);
      const idx2 = kgIds.indexOf(triplet[2].id);
      const score1 = idx1 >= 0 ? scores[idx1] : 0;
      const score2 = idx2 >= 0 ? scores[idx2] : 0;
      newScores.push(Math.max(score1, score2));
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
}
