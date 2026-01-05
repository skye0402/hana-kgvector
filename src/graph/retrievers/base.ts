import type { PropertyGraphStore } from "../property-graph-store";
import type { Triplet, NodeWithScore, QueryBundle, LabelledNode } from "../types";
import { TRIPLET_SOURCE_KEY, tripletToString } from "../types";

export const DEFAULT_PREAMBLE = "Here are some facts extracted from the provided text:\n\n";

export interface BasePGRetrieverOptions {
  graphStore: PropertyGraphStore;
  includeText?: boolean;
  includeTextPreamble?: string;
  includeProperties?: boolean;
}

export abstract class BasePGRetriever {
  protected readonly graphStore: PropertyGraphStore;
  protected readonly includeText: boolean;
  protected readonly includeTextPreamble: string;
  protected readonly includeProperties: boolean;

  constructor(options: BasePGRetrieverOptions) {
    this.graphStore = options.graphStore;
    this.includeText = options.includeText ?? true;
    this.includeTextPreamble = options.includeTextPreamble ?? DEFAULT_PREAMBLE;
    this.includeProperties = options.includeProperties ?? false;
  }

  protected getNodesWithScore(triplets: Triplet[], scores?: number[]): NodeWithScore[] {
    const results: NodeWithScore[] = [];

    for (let i = 0; i < triplets.length; i++) {
      const triplet = triplets[i];
      const sourceId = triplet[0].properties[TRIPLET_SOURCE_KEY] as string | undefined;

      const text = tripletToString(triplet, this.includeProperties);

      results.push({
        node: {
          id: `triplet_${i}`,
          text,
          metadata: {},
          refDocId: sourceId,
        },
        score: scores?.[i] ?? 1.0,
      });
    }

    return results;
  }

  protected async addSourceText(nodes: NodeWithScore[]): Promise<NodeWithScore[]> {
    if (!this.graphStore.getDocumentNodes) {
      return nodes;
    }

    const refDocIds = nodes
      .map((n) => n.node.refDocId)
      .filter((id): id is string => id !== undefined);

    if (refDocIds.length === 0) return nodes;

    const ogNodes = await this.graphStore.getDocumentNodes(refDocIds);
    const nodeMap = new Map(ogNodes.map((n) => [n.id, n]));

    const graphNodeMap = new Map<string, string[]>();
    for (const node of nodes) {
      const refDocId = node.node.refDocId ?? "";
      if (!graphNodeMap.has(refDocId)) {
        graphNodeMap.set(refDocId, []);
      }
      graphNodeMap.get(refDocId)!.push(node.node.text);
    }

    const resultNodes: NodeWithScore[] = [];
    for (const nodeWithScore of nodes) {
      const mappedNode = nodeMap.get(nodeWithScore.node.refDocId ?? "");

      if (mappedNode) {
        const graphContent = graphNodeMap.get(mappedNode.id) ?? [];
        if (graphContent.length > 0) {
          const graphContentStr = graphContent.join("\n");
          const newContent = this.includeTextPreamble + graphContentStr + "\n\n" + mappedNode.text;
          resultNodes.push({
            node: {
              id: mappedNode.id,
              text: newContent,
              metadata: mappedNode.metadata,
              refDocId: nodeWithScore.node.refDocId,
            },
            score: nodeWithScore.score,
          });
        } else {
          resultNodes.push({
            node: {
              id: mappedNode.id,
              text: mappedNode.text,
              metadata: mappedNode.metadata,
              refDocId: nodeWithScore.node.refDocId,
            },
            score: nodeWithScore.score,
          });
        }
      } else {
        resultNodes.push(nodeWithScore);
      }
    }

    return resultNodes;
  }

  async retrieve(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    let nodes = await this.retrieveFromGraph(queryBundle);
    if (this.includeText && nodes.length > 0) {
      nodes = await this.addSourceText(nodes);
    }
    return nodes;
  }

  abstract retrieveFromGraph(queryBundle: QueryBundle): Promise<NodeWithScore[]>;
}
