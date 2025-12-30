import type { HanaConnection } from "./types";

export type VectorDistance = "cosine" | "l2";

export type VectorRow = {
  id: string;
  spaceId: string;
  content: string;
  score: number;
};

export class HanaVectorStore {
  private readonly conn: HanaConnection;
  private readonly tableName: string;

  constructor(conn: HanaConnection, options: { tableName: string }) {
    this.conn = conn;
    this.tableName = options.tableName;
  }

  async ensureTable(options: { vectorDimension: number }): Promise<void> {
    const sql = `
CREATE TABLE ${this.tableName} (
  id NVARCHAR(64) PRIMARY KEY,
  space_id NVARCHAR(128) NOT NULL,
  content NCLOB,
  content_hash NVARCHAR(32),
  embedding REAL_VECTOR(${options.vectorDimension})
)`;

    try {
      await new Promise<void>((resolve, reject) => {
        this.conn.exec(sql, (err: unknown) => (err ? reject(err) : resolve()));
      });
    } catch {
      // Table likely exists; ignore.
    }
  }

  async addChunk(options: {
    id: string;
    spaceId: string;
    content: string;
    contentHash?: string;
    embedding: number[];
  }): Promise<void> {
    const sql = `
INSERT INTO ${this.tableName} (id, space_id, content, content_hash, embedding)
VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?))
`;

    await new Promise<void>((resolve, reject) => {
      (this.conn as any).exec(
        sql,
        [options.id, options.spaceId, options.content, options.contentHash ?? null, JSON.stringify(options.embedding)],
        (err: unknown) => (err ? reject(err) : resolve())
      );
    });
  }

  async similaritySearch(options: {
    spaceId: string;
    queryEmbedding: number[];
    topK: number;
  }): Promise<VectorRow[]> {
    const sql = `
SELECT
  id,
  space_id,
  content,
  COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS score
FROM ${this.tableName}
WHERE space_id = ?
ORDER BY score DESC
LIMIT ?
`;

    const rows = await new Promise<any[]>((resolve, reject) => {
      (this.conn as any).exec(
        sql,
        [JSON.stringify(options.queryEmbedding), options.spaceId, options.topK],
        (err: unknown, result: any) => (err ? reject(err) : resolve(result))
      );
    });

    return (rows ?? []).map((r) => ({
      id: String(r.ID ?? r.id),
      spaceId: String(r.SPACE_ID ?? r.space_id),
      content: String(r.CONTENT ?? r.content ?? ""),
      score: Number(r.SCORE ?? r.score ?? 0)
    }));
  }
}
