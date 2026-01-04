import type { TransformComponent, TextNode } from "./types";
import type { Relation } from "../types";
import { KG_RELATIONS_KEY, STRUCT_SAME_PAGE, STRUCT_ADJACENT } from "../types";

export interface AdjacencyLinkerOptions {
  /**
   * Link chunks that share the same pageNumber in metadata.
   * Default: true
   */
  linkSamePage?: boolean;

  /**
   * Link chunks that are adjacent by chunkIndex in metadata.
   * Default: true
   */
  linkAdjacent?: boolean;

  /**
   * Maximum chunk index distance for ADJACENT_TO links.
   * Default: 1 (immediate neighbors only)
   */
  adjacentDistance?: number;

  /**
   * Only create cross-type links (e.g., text↔image), not text↔text.
   * Default: false (link all)
   */
  crossTypeOnly?: boolean;
}

export class AdjacencyLinker implements TransformComponent {
  private linkSamePage: boolean;
  private linkAdjacent: boolean;
  private adjacentDistance: number;
  private crossTypeOnly: boolean;

  constructor(options: AdjacencyLinkerOptions = {}) {
    this.linkSamePage = options.linkSamePage ?? true;
    this.linkAdjacent = options.linkAdjacent ?? true;
    this.adjacentDistance = options.adjacentDistance ?? 1;
    this.crossTypeOnly = options.crossTypeOnly ?? false;
  }

  /**
   * Transform is called AFTER other extractors (SchemaLLMPathExtractor, ImplicitPathExtractor).
   * It adds structural relations between chunks based on metadata.
   */
  async transform(nodes: TextNode[], options?: { showProgress?: boolean }): Promise<TextNode[]> {
    if (nodes.length < 2) return nodes;

    // Group nodes by documentId
    const byDocument = new Map<string, TextNode[]>();
    for (const node of nodes) {
      const docId = String(node.metadata.documentId ?? "unknown");
      if (!byDocument.has(docId)) byDocument.set(docId, []);
      byDocument.get(docId)!.push(node);
    }

    // For each document, create structural links
    // Map from node.id to relations that should be added to that node
    const nodeRelationsMap = new Map<string, Relation[]>();

    for (const [docId, docNodes] of byDocument) {
      // Group by page
      const byPage = new Map<number, TextNode[]>();
      for (const node of docNodes) {
        const page = Number(node.metadata.pageNumber ?? 0);
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(node);
      }

      // Same-page links
      if (this.linkSamePage) {
        for (const [page, pageNodes] of byPage) {
          if (pageNodes.length < 2) continue;
          for (let i = 0; i < pageNodes.length; i++) {
            for (let j = i + 1; j < pageNodes.length; j++) {
              const a = pageNodes[i];
              const b = pageNodes[j];
              if (this.shouldLink(a, b)) {
                this.addRelation(nodeRelationsMap, a.id, b.id, STRUCT_SAME_PAGE, { pageNumber: page, documentId: docId });
              }
            }
          }
        }
      }

      // Adjacent chunk links (by chunkIndex)
      if (this.linkAdjacent) {
        // Sort by chunkIndex
        const sorted = [...docNodes].sort((a, b) => {
          const idxA = Number(a.metadata.chunkIndex ?? 0);
          const idxB = Number(b.metadata.chunkIndex ?? 0);
          return idxA - idxB;
        });

        for (let i = 0; i < sorted.length; i++) {
          for (let d = 1; d <= this.adjacentDistance && i + d < sorted.length; d++) {
            const a = sorted[i];
            const b = sorted[i + d];
            if (this.shouldLink(a, b)) {
              this.addRelation(nodeRelationsMap, a.id, b.id, STRUCT_ADJACENT, { distance: d, documentId: docId });
            }
          }
        }
      }
    }

    // Merge relations into node metadata
    return nodes.map((node) => {
      const existingRelations = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];
      const newRelations = nodeRelationsMap.get(node.id) ?? [];

      return {
        ...node,
        metadata: {
          ...node.metadata,
          [KG_RELATIONS_KEY]: [...existingRelations, ...newRelations],
        },
      };
    });
  }

  private shouldLink(a: TextNode, b: TextNode): boolean {
    if (!this.crossTypeOnly) return true;
    const typeA = String(a.metadata.contentType ?? "text");
    const typeB = String(b.metadata.contentType ?? "text");
    return typeA !== typeB;
  }

  private addRelation(
    map: Map<string, Relation[]>,
    sourceNodeId: string,
    targetNodeId: string,
    label: string,
    properties: Record<string, unknown>
  ): void {
    // Create CHUNK entity IDs (matching ImplicitPathExtractor format)
    const sourceId = `CHUNK_${sourceNodeId.replace(/\s+/g, "_").toUpperCase()}`;
    const targetId = `CHUNK_${targetNodeId.replace(/\s+/g, "_").toUpperCase()}`;

    const rel: Relation = {
      id: `${sourceId}_${label}_${targetId}`,
      label,
      sourceId,
      targetId,
      properties,
    };

    // Add to source node
    if (!map.has(sourceNodeId)) map.set(sourceNodeId, []);
    map.get(sourceNodeId)!.push(rel);

    // Bidirectional: also add reverse to target node
    const reverseRel: Relation = {
      id: `${targetId}_${label}_${sourceId}`,
      label,
      sourceId: targetId,
      targetId: sourceId,
      properties,
    };

    if (!map.has(targetNodeId)) map.set(targetNodeId, []);
    map.get(targetNodeId)!.push(reverseRel);
  }
}
