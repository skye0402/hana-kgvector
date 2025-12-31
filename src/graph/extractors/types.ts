import type { EntityNode, Relation, Triplet } from "../types";

export interface TextNode {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  hash?: string;
}

export interface TransformComponent {
  transform(nodes: TextNode[], options?: { showProgress?: boolean }): Promise<TextNode[]>;
}

export interface ExtractedKG {
  nodes: EntityNode[];
  relations: Relation[];
  triplets: Triplet[];
}

export type EntityType = string;
export type RelationType = string;

export interface SchemaDefinition {
  entityTypes: EntityType[];
  relationTypes: RelationType[];
  validationSchema?: Array<[EntityType, RelationType, EntityType]>;
}
