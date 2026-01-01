import type { PropertyGraphStore } from "./property-graph-store";
import type { TransformComponent, TextNode } from "./extractors/types";
import type { EntityNode, Relation, NodeWithScore, QueryBundle } from "./types";
import { KG_NODES_KEY, KG_RELATIONS_KEY, TRIPLET_SOURCE_KEY } from "./types";
import { PGRetriever } from "./pg-retriever";
import { VectorContextRetriever, type EmbedModel } from "./retrievers/vector-context";
import { ImplicitPathExtractor } from "./extractors/implicit";
import { createHash } from "crypto";

export interface PropertyGraphIndexOptions {
  propertyGraphStore: PropertyGraphStore;
  kgExtractors?: TransformComponent[];
  embedModel?: EmbedModel;
  embedKgNodes?: boolean;
  showProgress?: boolean;
}

export class PropertyGraphIndex {
  private readonly propertyGraphStore: PropertyGraphStore;
  private readonly kgExtractors: TransformComponent[];
  private readonly embedModel?: EmbedModel;
  private readonly embedKgNodes: boolean;
  private readonly showProgress: boolean;

  constructor(options: PropertyGraphIndexOptions) {
    this.propertyGraphStore = options.propertyGraphStore;
    this.kgExtractors = options.kgExtractors ?? [new ImplicitPathExtractor()];
    this.embedModel = options.embedModel;
    this.embedKgNodes = options.embedKgNodes ?? true;
    this.showProgress = options.showProgress ?? false;
  }

  get graphStore(): PropertyGraphStore {
    return this.propertyGraphStore;
  }

  static fromExisting(options: PropertyGraphIndexOptions): PropertyGraphIndex {
    return new PropertyGraphIndex(options);
  }

  private computeHash(text: string): string {
    return createHash("md5").update(text).digest("hex");
  }

  async insert(nodes: TextNode[]): Promise<TextNode[]> {
    if (nodes.length === 0) return [];

    let processedNodes = nodes;
    for (const extractor of this.kgExtractors) {
      processedNodes = await extractor.transform(processedNodes, {
        showProgress: this.showProgress,
      });
    }

    for (const node of processedNodes) {
      if (!node.metadata[KG_NODES_KEY] && !node.metadata[KG_RELATIONS_KEY]) {
        throw new Error(`Node ${node.id} has no KG_NODES_KEY or KG_RELATIONS_KEY after extraction`);
      }
    }

    const kgNodesToInsert: EntityNode[] = [];
    const kgRelsToInsert: Relation[] = [];

    for (const node of processedNodes) {
      const kgNodes = (node.metadata[KG_NODES_KEY] as EntityNode[]) ?? [];
      const kgRels = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];

      for (const kgNode of kgNodes) {
        kgNode.properties[TRIPLET_SOURCE_KEY] = node.id;
      }
      for (const kgRel of kgRels) {
        kgRel.properties[TRIPLET_SOURCE_KEY] = node.id;
      }

      kgNodesToInsert.push(...kgNodes);
      kgRelsToInsert.push(...kgRels);
    }

    const kgNodeIds = [...new Set(kgNodesToInsert.map((n) => n.id))];
    const existingKgNodes = await this.propertyGraphStore.get({ ids: kgNodeIds });
    const existingKgNodeIds = new Set(existingKgNodes.map((n) => n.id));
    const newKgNodes = kgNodesToInsert.filter((n) => !existingKgNodeIds.has(n.id));

    if (this.propertyGraphStore.getLlamaNodes) {
      const existingLlamaNodes = await this.propertyGraphStore.getLlamaNodes(
        processedNodes.map((n) => n.id)
      );
      const existingHashes = new Set(existingLlamaNodes.map((n) => n.hash));
      processedNodes = processedNodes.filter((n) => {
        const hash = this.computeHash(n.text);
        n.hash = hash;
        return !existingHashes.has(hash);
      });
    }

    if (this.embedKgNodes && this.embedModel && newKgNodes.length > 0) {
      const nodeTexts = processedNodes.map((n) => n.text);
      const embeddings = await this.embedModel.getTextEmbeddingBatch(nodeTexts);
      for (let i = 0; i < processedNodes.length; i++) {
        processedNodes[i].embedding = embeddings[i];
      }

      const kgNodeTexts = newKgNodes.map((n) => `${n.label}: ${n.name}`);
      const kgEmbeddings = await this.embedModel.getTextEmbeddingBatch(kgNodeTexts);
      for (let i = 0; i < newKgNodes.length; i++) {
        newKgNodes[i].embedding = kgEmbeddings[i];
      }
    }

    if (this.propertyGraphStore.upsertLlamaNodes && processedNodes.length > 0) {
      await this.propertyGraphStore.upsertLlamaNodes(
        processedNodes.map((n) => ({
          id: n.id,
          text: n.text,
          metadata: n.metadata,
          embedding: n.embedding,
          hash: n.hash,
        }))
      );
    }

    if (newKgNodes.length > 0) {
      await this.propertyGraphStore.upsertNodes(newKgNodes);
    }

    if (kgRelsToInsert.length > 0) {
      await this.propertyGraphStore.upsertRelations(kgRelsToInsert);
    }

    return processedNodes;
  }

  async delete(nodeIds: string[]): Promise<void> {
    await this.propertyGraphStore.delete({ ids: nodeIds });
  }

  asRetriever(options?: {
    subRetrievers?: Array<{ retrieve(query: QueryBundle): Promise<NodeWithScore[]> }>;
    includeText?: boolean;
    /** Number of top similar nodes to retrieve via vector search (default: 4) */
    similarityTopK?: number;
    /** Graph traversal depth from matched nodes (default: 1) */
    pathDepth?: number;
    /** Maximum number of triplets to return after expansion (default: 30) */
    limit?: number;
    /** Minimum similarity score threshold to include results (default: no threshold) */
    similarityScore?: number;
    /** Enable cross-check boosting: boost scores when vector-matched entities link to graph facts (default: true) */
    crossCheckBoost?: boolean;
    /** Multiplier for cross-check boost (default: 1.25 = 25% boost) */
    crossCheckBoostFactor?: number;
  }): PGRetriever {
    let subRetrievers = options?.subRetrievers as any[];

    if (!subRetrievers && this.embedModel && this.propertyGraphStore.supportsVectorQueries) {
      subRetrievers = [
        new VectorContextRetriever({
          graphStore: this.propertyGraphStore,
          embedModel: this.embedModel,
          includeText: options?.includeText ?? true,
          similarityTopK: options?.similarityTopK,
          pathDepth: options?.pathDepth,
          limit: options?.limit,
          similarityScore: options?.similarityScore,
          crossCheckBoost: options?.crossCheckBoost,
          crossCheckBoostFactor: options?.crossCheckBoostFactor,
        }),
      ];
    }

    if (!subRetrievers) {
      subRetrievers = [];
    }

    return new PGRetriever({ subRetrievers });
  }

  async query(queryStr: string, options?: {
    /** Number of top similar nodes to retrieve via vector search (default: 4) */
    similarityTopK?: number;
    /** Graph traversal depth from matched nodes (default: 1) */
    pathDepth?: number;
    /** Maximum number of triplets to return after expansion (default: 30) */
    limit?: number;
    /** Minimum similarity score threshold to include results (default: no threshold) */
    similarityScore?: number;
    /** Enable cross-check boosting: boost scores when vector-matched entities link to graph facts (default: true) */
    crossCheckBoost?: boolean;
    /** Multiplier for cross-check boost (default: 1.25 = 25% boost) */
    crossCheckBoostFactor?: number;
  }): Promise<NodeWithScore[]> {
    const retriever = this.asRetriever(options);
    return retriever.retrieve({ queryStr });
  }
}
