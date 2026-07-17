import type { EntityNode, Relation, Triplet, NodeWithScore } from "../graph/types";

export type NativeGraphChunk = {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  hash?: string;
};

export type NativeGraphBuildInput = {
  entities: EntityNode[];
  relations: Relation[];
  chunks: NativeGraphChunk[];
};

export type NativeQueryOptions = {
  similarityTopK?: number;
  pathDepth?: number;
  limit?: number;
  similarityScore?: number;
};

export type NativeEntityResult = EntityNode;

export type NativeRelationshipResult = {
  source: EntityNode;
  relation: Relation;
  target: EntityNode;
};

export type NativeQueryResult = NodeWithScore;

export type NativeGraphInfo = {
  graphName: string;
  hasChunks: boolean;
  chunksCount?: number;
};

export type HanaNativeStoreOptions = {
  graphName: string;
  chunkTableName?: string;
  sqlBatchSize?: number;
  resetTables?: boolean;
};

export type NativeHybridSearchResult = {
  chunks: NodeWithScore[];
  triplets: Array<{ triplet: Triplet; score: number }>;
};
