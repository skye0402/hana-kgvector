import type { EmbedModel } from "../graph/retrievers/vector-context";
import type { EntityNode, Relation, NodeWithScore } from "../graph/types";
import type { NativeGraphBuildInput, NativeGraphChunk, NativeQueryOptions } from "./types";
import { HanaNativeVectorStore } from "./hana-native-vector-store";
import { HanaNativeKnowledgeGraphStore } from "./hana-native-knowledge-graph-store";
import { HanaNativeHybridRetriever } from "./hana-native-hybrid-retriever";

export class HanaNativeGraphRagIndex {
  private readonly vectorStore: HanaNativeVectorStore;
  private readonly knowledgeGraphStore: HanaNativeKnowledgeGraphStore;
  private readonly embedModel?: EmbedModel;

  constructor(options: {
    vectorStore: HanaNativeVectorStore;
    knowledgeGraphStore: HanaNativeKnowledgeGraphStore;
    embedModel?: EmbedModel;
  }) {
    this.vectorStore = options.vectorStore;
    this.knowledgeGraphStore = options.knowledgeGraphStore;
    this.embedModel = options.embedModel;
  }

  async insertGraph(input: NativeGraphBuildInput): Promise<void> {
    await this.knowledgeGraphStore.upsertEntities(input.entities);

    const entityById = new Map<string, EntityNode>();
    for (const entity of input.entities) entityById.set(entity.id, entity);

    await this.knowledgeGraphStore.upsertRelations(input.relations, entityById);
    await this.vectorStore.upsertChunks(input.chunks);
    await this.knowledgeGraphStore.linkChunks(input.chunks, input.entities);
  }

  async insertChunks(chunks: NativeGraphChunk[]): Promise<void> {
    await this.vectorStore.upsertChunks(chunks);
  }

  async query(query: string, options?: NativeQueryOptions): Promise<NodeWithScore[]> {
    if (!this.embedModel) {
      throw new Error("HanaNativeGraphRagIndex.query requires an embedModel");
    }

    return new HanaNativeHybridRetriever({
      vectorStore: this.vectorStore,
      knowledgeGraphStore: this.knowledgeGraphStore,
      embedModel: this.embedModel,
    }).retrieve(query, options);
  }

  async getEntities(entityType?: string): Promise<EntityNode[]> {
    return this.knowledgeGraphStore.getEntities(entityType);
  }

  async getRelationships(options: {
    entityName: string;
    relType?: string;
    depth?: number;
    limit?: number;
  }): Promise<Array<{ source: EntityNode; relation: Relation; target: EntityNode }>> {
    const seedEntities = await this.knowledgeGraphStore.findEntitiesByName(options.entityName);
    return this.knowledgeGraphStore.getRelationships({
      seedEntities,
      relType: options.relType,
      depth: options.depth,
      limit: options.limit,
    });
  }

  async delete(): Promise<void> {
    await this.knowledgeGraphStore.clear();
    await this.vectorStore.delete();
  }
}
