import type { HanaConnection } from "../hana/types";
import type { NativeGraphChunk, HanaNativeStoreOptions } from "./types";
import { md5, quoteIdentifier, resolveSqlBatchSize, safeJsonParse, sanitizeIdentifier } from "./util";

export class HanaNativeVectorStore {
  private readonly conn: HanaConnection;
  readonly graphName: string;
  readonly chunkTableName: string;
  private readonly sqlBatchSize: number;
  private readonly resetTables: boolean;
  private initialized = false;

  constructor(conn: HanaConnection, options: HanaNativeStoreOptions) {
    this.conn = conn;
    this.graphName = options.graphName;
    this.chunkTableName = options.chunkTableName ?? `${sanitizeIdentifier(options.graphName)}_CHUNKS`;
    this.sqlBatchSize = resolveSqlBatchSize(options.sqlBatchSize);
    this.resetTables = options.resetTables ?? false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.resetTables) {
      await this.exec(`DROP TABLE ${quoteIdentifier(this.chunkTableName)}`).catch(() => {});
    }

    await this.exec(`
      CREATE COLUMN TABLE ${quoteIdentifier(this.chunkTableName)} (
        id NVARCHAR(512) PRIMARY KEY,
        text NCLOB,
        metadata NCLOB,
        object_name NVARCHAR(512),
        file_name NVARCHAR(1024),
        chunk_index INTEGER,
        hash NVARCHAR(64),
        embedding REAL_VECTOR
      )
    `).catch((err: any) => {
      const message = String(err?.message ?? err ?? "");
      if (!/exists|duplicate table name/i.test(message)) throw err;
    });

    this.initialized = true;
  }

  async upsertChunks(chunks: NativeGraphChunk[]): Promise<void> {
    await this.initialize();
    if (chunks.length === 0) return;

    const withEmbedding: unknown[][] = [];
    const withoutEmbedding: unknown[][] = [];
    const seen = new Set<string>();

    for (const chunk of chunks) {
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);

      const metadataJson = JSON.stringify(chunk.metadata ?? {});
      const row = [
        chunk.id,
        chunk.text,
        metadataJson,
        String(chunk.metadata?.objectName ?? chunk.metadata?.object_name ?? ""),
        String(chunk.metadata?.fileName ?? chunk.metadata?.file_name ?? ""),
        Number(chunk.metadata?.chunkIndex ?? chunk.metadata?.chunk_index ?? 0),
        chunk.hash ?? md5(chunk.text),
      ];

      if (chunk.embedding) withEmbedding.push([...row, JSON.stringify(chunk.embedding)]);
      else withoutEmbedding.push(row);
    }

    await this.execBatch(`
      UPSERT ${quoteIdentifier(this.chunkTableName)}
        (id, text, metadata, object_name, file_name, chunk_index, hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, TO_REAL_VECTOR(?))
      WITH PRIMARY KEY
    `, withEmbedding);

    await this.execBatch(`
      UPSERT ${quoteIdentifier(this.chunkTableName)}
        (id, text, metadata, object_name, file_name, chunk_index, hash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      WITH PRIMARY KEY
    `, withoutEmbedding);
  }

  async queryByEmbedding(options: {
    embedding: number[];
    topK: number;
    minScore?: number;
  }): Promise<Array<{ id: string; text: string; metadata: Record<string, unknown>; score: number }>> {
    await this.initialize();

    const thresholdClause = options.minScore === undefined ? "" : "WHERE score >= ?";
    const params: unknown[] = [JSON.stringify(options.embedding)];
    if (options.minScore !== undefined) params.push(options.minScore);
    params.push(options.topK);

    const rows = await this.exec(`
      SELECT id, text, metadata, score
      FROM (
        SELECT id, text, metadata,
          COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS score
        FROM ${quoteIdentifier(this.chunkTableName)}
        WHERE embedding IS NOT NULL
      )
      ${thresholdClause}
      ORDER BY score DESC
      LIMIT ?
    `, params) as any[];

    return (rows ?? []).map((row) => ({
      id: row.ID ?? row.id,
      text: row.TEXT ?? row.text ?? "",
      metadata: safeJsonParse(row.METADATA ?? row.metadata),
      score: Number(row.SCORE ?? row.score ?? 0),
    }));
  }

  async getChunks(ids: string[]): Promise<NativeGraphChunk[]> {
    await this.initialize();
    if (ids.length === 0) return [];

    const rows = await this.exec(
      `SELECT id, text, metadata, hash FROM ${quoteIdentifier(this.chunkTableName)} WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids
    ) as any[];

    return (rows ?? []).map((row) => ({
      id: row.ID ?? row.id,
      text: row.TEXT ?? row.text ?? "",
      metadata: safeJsonParse(row.METADATA ?? row.metadata),
      hash: row.HASH ?? row.hash,
    }));
  }

  async countChunks(): Promise<number> {
    await this.initialize();
    const rows = await this.exec(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(this.chunkTableName)}`) as any[];
    return Number(rows?.[0]?.COUNT ?? rows?.[0]?.count ?? 0);
  }

  async delete(): Promise<void> {
    await this.exec(`DROP TABLE ${quoteIdentifier(this.chunkTableName)}`).catch(() => {});
    this.initialized = false;
  }

  private async exec(sql: string, params?: unknown[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (params && params.length > 0) {
        (this.conn as any).exec(sql, params, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result as unknown[]);
        });
      } else {
        this.conn.exec(sql, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result as unknown[]);
        });
      }
    });
  }

  private async execBatch(sql: string, paramRows: unknown[][]): Promise<void> {
    if (paramRows.length === 0) return;

    if (typeof (this.conn as any).prepare !== "function") {
      for (const params of paramRows) await this.exec(sql, params);
      return;
    }

    for (let i = 0; i < paramRows.length; i += this.sqlBatchSize) {
      const chunk = paramRows.slice(i, i + this.sqlBatchSize);
      const stmt = await new Promise<any>((resolve, reject) => {
        (this.conn as any).prepare(sql, (err: unknown, prepared: unknown) => {
          if (err) reject(err);
          else resolve(prepared);
        });
      });

      try {
        if (typeof stmt.execBatch !== "function") {
          for (const params of chunk) await this.exec(sql, params);
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          stmt.execBatch(chunk, (err: unknown) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } finally {
        try {
          stmt.drop?.();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}
