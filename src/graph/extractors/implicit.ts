import type { TransformComponent, TextNode } from "./types";
import type { EntityNode, Relation } from "../types";
import { KG_NODES_KEY, KG_RELATIONS_KEY, createEntityNode, createRelation } from "../types";

export class ImplicitPathExtractor implements TransformComponent {
  async transform(nodes: TextNode[], options?: { showProgress?: boolean }): Promise<TextNode[]> {
    const results: TextNode[] = [];

    for (const node of nodes) {
      const existingNodes = (node.metadata[KG_NODES_KEY] as EntityNode[]) ?? [];
      const existingRelations = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];

      const safeMetadata: Record<string, unknown> = { ...node.metadata };
      delete safeMetadata[KG_NODES_KEY];
      delete safeMetadata[KG_RELATIONS_KEY];

      const chunkNode = createEntityNode({
        label: "CHUNK",
        name: node.id,
        properties: {
          text: node.text.slice(0, 500),
          ...safeMetadata,
        },
      });

      if (node.metadata.documentId) {
        const docNode = createEntityNode({
          label: "DOCUMENT",
          name: String(node.metadata.documentId),
          properties: {},
        });

        const rel = createRelation({
          label: "FROM_DOCUMENT",
          sourceId: chunkNode.id,
          targetId: docNode.id,
        });

        existingNodes.push(docNode);
        existingRelations.push(rel);
      }

      existingNodes.push(chunkNode);

      results.push({
        ...node,
        metadata: {
          ...node.metadata,
          [KG_NODES_KEY]: existingNodes,
          [KG_RELATIONS_KEY]: existingRelations,
        },
      });
    }

    return results;
  }
}
