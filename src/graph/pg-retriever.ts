import type { QueryBundle, NodeWithScore } from "./types";
import type { BasePGRetriever } from "./retrievers/base";

export interface PGRetrieverOptions {
  subRetrievers: BasePGRetriever[];
  showProgress?: boolean;
}

export class PGRetriever {
  private readonly subRetrievers: BasePGRetriever[];
  private readonly showProgress: boolean;

  constructor(options: PGRetrieverOptions) {
    this.subRetrievers = options.subRetrievers;
    this.showProgress = options.showProgress ?? false;
  }

  private deduplicate(nodes: NodeWithScore[]): NodeWithScore[] {
    const seen = new Set<string>();
    const deduped: NodeWithScore[] = [];

    for (const node of nodes) {
      if (!seen.has(node.node.text)) {
        deduped.push(node);
        seen.add(node.node.text);
      }
    }

    return deduped;
  }

  async retrieve(queryBundle: QueryBundle): Promise<NodeWithScore[]> {
    const allResults: NodeWithScore[] = [];

    const promises = this.subRetrievers.map((r) => r.retrieve(queryBundle));
    const results = await Promise.all(promises);

    for (const result of results) {
      allResults.push(...result);
    }

    return this.deduplicate(allResults);
  }
}
