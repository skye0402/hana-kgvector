import { z } from "zod";

export const TRIPLET_SOURCE_KEY = "triplet_source_id";
export const KG_NODES_KEY = "kg_nodes";
export const KG_RELATIONS_KEY = "kg_relations";
export const VECTOR_SOURCE_KEY = "vector_source_id";
export const KG_SOURCE_REL = "HAS_SOURCE";

export const EntityNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  name: z.string(),
  properties: z.record(z.unknown()).default({}),
  embedding: z.array(z.number()).optional(),
});

export type EntityNode = z.infer<typeof EntityNodeSchema>;

export const RelationSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  properties: z.record(z.unknown()).default({}),
});

export type Relation = z.infer<typeof RelationSchema>;

export type Triplet = [EntityNode, Relation, EntityNode];

export type LabelledNode = EntityNode;

export interface NodeWithScore {
  node: {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
    refDocId?: string;
  };
  score: number;
}

export interface QueryBundle {
  queryStr: string;
  embedding?: number[];
  embeddingStrs?: string[];
}

export function createEntityNode(opts: {
  label: string;
  name: string;
  properties?: Record<string, unknown>;
  embedding?: number[];
}): EntityNode {
  const id = `${opts.label.toUpperCase()}_${opts.name.replace(/\s+/g, "_").toUpperCase()}`;
  return {
    id,
    label: opts.label,
    name: opts.name,
    properties: opts.properties ?? {},
    embedding: opts.embedding,
  };
}

export function createRelation(opts: {
  label: string;
  sourceId: string;
  targetId: string;
  properties?: Record<string, unknown>;
}): Relation {
  return {
    id: `${opts.sourceId}_${opts.label}_${opts.targetId}`,
    label: opts.label,
    sourceId: opts.sourceId,
    targetId: opts.targetId,
    properties: opts.properties ?? {},
  };
}

export function tripletToString(triplet: Triplet, includeProperties = false): string {
  const [subj, rel, obj] = triplet;
  if (includeProperties) {
    return `${subj.name} (${subj.label}) -[${rel.label}]-> ${obj.name} (${obj.label})`;
  }
  return `${subj.id} -> ${rel.label} -> ${obj.id}`;
}
