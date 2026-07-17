import type { NodeWithScore } from "../graph/types";
import type { EmbedModel } from "../graph/retrievers/vector-context";
import type { NativeQueryOptions } from "./types";
import { tripletToString } from "../graph/types";
import { HanaNativeVectorStore } from "./hana-native-vector-store";
import { HanaNativeKnowledgeGraphStore } from "./hana-native-knowledge-graph-store";

export class HanaNativeHybridRetriever {
  private readonly vectorStore: HanaNativeVectorStore;
  private readonly knowledgeGraphStore: HanaNativeKnowledgeGraphStore;
  private readonly embedModel: EmbedModel;

  constructor(options: {
    vectorStore: HanaNativeVectorStore;
    knowledgeGraphStore: HanaNativeKnowledgeGraphStore;
    embedModel: EmbedModel;
  }) {
    this.vectorStore = options.vectorStore;
    this.knowledgeGraphStore = options.knowledgeGraphStore;
    this.embedModel = options.embedModel;
  }

  async retrieve(query: string, options?: NativeQueryOptions): Promise<NodeWithScore[]> {
    const embedding = await this.embedModel.getTextEmbedding(query);
    const similarityTopK = options?.similarityTopK ?? 10;
    const limit = options?.limit ?? 30;

    const chunks = await this.vectorStore.queryByEmbedding({
      embedding,
      topK: similarityTopK,
      minScore: options?.similarityScore,
    });

    const chunkResults: NodeWithScore[] = chunks.map((chunk) => ({
      node: {
        id: chunk.id,
        text: chunk.text,
        metadata: { ...chunk.metadata, resultType: "chunk" },
        refDocId: chunk.id,
      },
      score: chunk.score,
    }));

    const scoreByChunkId = new Map(chunks.map((chunk) => [chunk.id, chunk.score]));
    const tripletRows = await this.knowledgeGraphStore.getChunkTriplets(
      chunks.map((chunk) => chunk.id),
      { depth: options?.pathDepth ?? 2, limit }
    );

    const tripletResults: NodeWithScore[] = tripletRows.map(({ triplet, chunkIds }) => {
      const score = chunkIds.reduce((best, id) => Math.max(best, scoreByChunkId.get(id) ?? 0), 0);
      return {
        node: {
          id: `${triplet[0].id}_${triplet[1].label}_${triplet[2].id}`,
          text: tripletToString(triplet, true),
          metadata: {
            resultType: "triplet",
            source: triplet[0],
            relation: triplet[1],
            target: triplet[2],
            sourceChunkIds: chunkIds,
          },
        },
        score,
      };
    });

    return this.deduplicate([...chunkResults, ...tripletResults])
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private deduplicate(results: NodeWithScore[]): NodeWithScore[] {
    const seen = new Set<string>();
    const deduped: NodeWithScore[] = [];
    for (const result of results) {
      const resultType = String(result.node.metadata?.resultType ?? "result");
      const key = `${resultType}:${result.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
    }
    return deduped;
  }
}
