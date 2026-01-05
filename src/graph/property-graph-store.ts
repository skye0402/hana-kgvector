import type { EntityNode, Relation, Triplet, LabelledNode } from "./types";

export interface VectorStoreQuery {
  queryEmbedding: number[];
  similarityTopK: number;
  filters?: Record<string, unknown>;
}

export interface PropertyGraphStore {
  readonly supportsVectorQueries: boolean;
  readonly supportsStructuredQueries: boolean;

  upsertNodes(nodes: EntityNode[]): Promise<void>;
  upsertRelations(relations: Relation[]): Promise<void>;

  get(opts: { ids: string[] }): Promise<LabelledNode[]>;
  getRelMap(opts: {
    nodes: LabelledNode[];
    depth?: number;
    limit?: number;
    ignoreRels?: string[];
  }): Promise<Triplet[]>;

  delete(opts: { ids: string[] }): Promise<void>;

  vectorQuery?(query: VectorStoreQuery): Promise<[LabelledNode[], number[]]>;

  getSchema?(opts?: { refresh?: boolean }): Promise<Record<string, unknown>>;

  upsertDocumentNodes?(nodes: Array<{ id: string; text: string; metadata: Record<string, unknown>; embedding?: number[] }>): Promise<void>;
  getDocumentNodes?(ids: string[]): Promise<Array<{ id: string; text: string; metadata: Record<string, unknown>; hash?: string }>>;
}
