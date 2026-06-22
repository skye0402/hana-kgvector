import type { HanaConnection } from "../hana/types";
import type { PropertyGraphStore, VectorStoreQuery } from "./property-graph-store";
import type { EntityNode, Relation, Triplet, LabelledNode } from "./types";
import { TRIPLET_SOURCE_KEY, KG_SOURCE_REL } from "./types";

type DocumentNode = {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  hash?: string;
};

export interface HanaPropertyGraphStoreOptions {
  graphName: string;
  vectorTableName?: string;
  documentNodesTableName?: string;
  /** Optional, unused for dimensionless REAL_VECTOR columns (kept for backward compat logging). */
  vectorDimension?: number;
  /** SQL execBatch chunk size for vector/document table writes. Defaults to HANA_KGVECTOR_SQL_BATCH_SIZE or 500. */
  sqlBatchSize?: number;
  /** If true, will DROP and recreate tables on init (intended for tests/dev only). */
  resetTables?: boolean;
}

export class HanaPropertyGraphStore implements PropertyGraphStore {
  private readonly conn: HanaConnection;
  private readonly graphName: string;
  private readonly vectorTableName: string;
  private readonly documentNodesTableName: string;
  private readonly sqlBatchSize: number;
  private readonly resetTables: boolean;
  private initialized = false;

  readonly supportsVectorQueries = true;
  readonly supportsStructuredQueries = true;

  constructor(conn: HanaConnection, options: HanaPropertyGraphStoreOptions) {
    this.conn = conn;
    this.graphName = options.graphName;
    this.vectorTableName = options.vectorTableName ?? `${options.graphName.replace(/[^a-zA-Z0-9]/g, "_")}_VECTORS`;
    this.documentNodesTableName = options.documentNodesTableName ?? `${options.graphName.replace(/[^a-zA-Z0-9]/g, "_")}_NODES`;
    this.sqlBatchSize = this.resolveSqlBatchSize(options.sqlBatchSize);
    this.resetTables = options.resetTables ?? false;
  }

  private resolveSqlBatchSize(configured?: number): number {
    const raw = configured ?? Number(process.env.HANA_KGVECTOR_SQL_BATCH_SIZE);
    if (!Number.isFinite(raw) || raw <= 0) return 500;
    return Math.floor(raw);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Optional destructive reset intended for tests/dev. This is OFF by default.
    if (this.resetTables) {
      await this.exec(`DROP TABLE ${this.vectorTableName}`).catch(() => {});
      await this.exec(`DROP TABLE ${this.documentNodesTableName}`).catch(() => {});

      // Also clear the RDF named graph to avoid accumulating triples across test runs.
      // (Tables are recreated, but the KG graph would otherwise persist.)
      await this.sparqlExecute(`CLEAR GRAPH <${this.graphName}>`).catch(() => {});
    }

    // HANA does not support "IF NOT EXISTS" for CREATE TABLE. We try to create and ignore the
    // "name exists" error, but surface any other errors.
    const createVectorTable = `
      CREATE COLUMN TABLE ${this.vectorTableName} (
        id NVARCHAR(512) PRIMARY KEY,
        node_type NVARCHAR(64),
        label NVARCHAR(128),
        name NVARCHAR(512),
        properties NCLOB,
        source_id NVARCHAR(512),
        target_id NVARCHAR(512),
        embedding REAL_VECTOR
      )
    `;
    await this.exec(createVectorTable).catch((err: any) => {
      const message = String(err?.message ?? "");
      // Handle "duplicate table name" or "already exists"
      if (!/exists|duplicate table name/i.test(message)) {
        throw err;
      }
    });

    // Migrate existing tables that lack the source_id / target_id columns.
    await this.exec(`ALTER TABLE ${this.vectorTableName} ADD (source_id NVARCHAR(512), target_id NVARCHAR(512))`).catch((err: any) => {
      const message = String(err?.message ?? "");
      // Ignore if columns already exist
      if (!/duplicate column|already exists/i.test(message)) {
        throw err;
      }
    });

    const createDocumentTable = `
      CREATE COLUMN TABLE ${this.documentNodesTableName} (
        id NVARCHAR(512) PRIMARY KEY,
        text NCLOB,
        metadata NCLOB,
        hash NVARCHAR(64),
        embedding REAL_VECTOR
      )
    `;
    await this.exec(createDocumentTable).catch((err: any) => {
      const message = String(err?.message ?? "");
      if (!/exists|duplicate table name/i.test(message)) {
        throw err;
      }
    });

    this.initialized = true;
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
      for (const params of paramRows) {
        await this.exec(sql, params);
      }
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
          for (const params of chunk) {
            await this.exec(sql, params);
          }
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
          // non-fatal cleanup
        }
      }
    }
  }

  private uniqueBy<T>(items: T[], getId: (item: T) => string): T[] {
    const byId = new Map<string, T>();

    for (const item of items) {
      byId.set(getId(item), item);
    }

    return Array.from(byId.values());
  }

  private sanitizeRecord(record: Record<string, unknown> | undefined): Record<string, unknown> {
    const safeRecord: Record<string, unknown> = { ...(record ?? {}) };
    delete (safeRecord as any).kg_nodes;
    delete (safeRecord as any).kg_relations;
    return safeRecord;
  }

  private async sparqlExecute(sparql: string, headers = ""): Promise<unknown> {
    // Some HANA environments require OUT parameters (e.g. RESPONSE) to be bound.
    // The @sap/hana-client driver provides a proc statement helper which correctly
    // handles OUT params *without* requiring you to pass them in the params array.
    try {
      const streamMod = await import("@sap/hana-client/extension/Stream");
      const Stream = (streamMod as any).default ?? streamMod;

      return await new Promise<unknown>((resolve, reject) => {
        Stream.createProcStatement(this.conn as any, "CALL SPARQL_EXECUTE(?, ?, ?, ?)", (err: any, stmt: any) => {
          if (err) return reject(err);
          stmt.exec([sparql, headers], (err2: any, scalarParams: any) => {
            // scalarParams contains OUT params by name (e.g. RESPONSE)
            if (err2) return reject(err2);
            resolve(scalarParams);
          });
        });
      });
    } catch {
      // Fallback (may fail on systems requiring bound OUT params)
      return await new Promise<unknown>((resolve, reject) => {
        (this.conn as any).exec(
          "CALL SPARQL_EXECUTE(?, ?, ?, ?)",
          // Important: only pass IN params; OUT params are placeholders in SQL.
          [sparql, headers],
          (err: unknown, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
    }
  }

  private entityToUri(node: EntityNode): string {
    return `<urn:hkv:${this.graphName}:${node.label}:${encodeURIComponent(node.id)}>`;
  }

  private relationToTriples(rel: Relation, subj: EntityNode, obj: EntityNode): string {
    const subjUri = this.entityToUri(subj);
    const objUri = this.entityToUri(obj);
    const predUri = `<urn:hkv:rel:${rel.label}>`;
    return `${subjUri} ${predUri} ${objUri} .`;
  }

  private entityToTriples(node: EntityNode): string {
    const uri = this.entityToUri(node);
    const lines: string[] = [];
    lines.push(`${uri} a <urn:hkv:type:${node.label}> .`);
    lines.push(`${uri} <urn:hkv:prop:name> "${this.escapeLiteral(node.name)}" .`);

    for (const [key, value] of Object.entries(node.properties)) {
      if (value !== undefined && value !== null) {
        const strVal = typeof value === "string" ? value : String(value);
        // Skip overly large properties in RDF — they are already stored in the vectors table
        if (strVal.length > 5000) continue;
        const escaped = this.escapeLiteral(strVal);
        lines.push(`${uri} <urn:hkv:prop:${key}> "${escaped}" .`);
      }
    }

    return lines.join("\n");
  }

  private escapeLiteral(s: string): string {
    return s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }

  async upsertNodes(nodes: EntityNode[]): Promise<void> {
    await this.ensureInitialized();
    if (nodes.length === 0) return;

    const uniqueNodes = this.uniqueBy(nodes, (node) => node.id);

    const triples = uniqueNodes.map((n) => this.entityToTriples(n)).join("\n");
    const sparql = `INSERT DATA { GRAPH <${this.graphName}> { ${triples} } }`;
    await this.sparqlExecute(sparql);

    const rowsWithEmbedding: unknown[][] = [];
    const rowsWithoutEmbedding: unknown[][] = [];

    for (const node of uniqueNodes) {
      const safeProps = this.sanitizeRecord(node.properties);
      const row = [node.id, node.label, node.name, JSON.stringify(safeProps)];
      if (node.embedding) {
        rowsWithEmbedding.push([...row, JSON.stringify(node.embedding)]);
      } else {
        rowsWithoutEmbedding.push(row);
      }
    }

    await this.execBatch(
      `
        UPSERT ${this.vectorTableName} (id, node_type, label, name, properties)
        VALUES (?, 'entity', ?, ?, ?)
        WITH PRIMARY KEY
      `,
      rowsWithoutEmbedding
    );

    await this.execBatch(
      `
        UPSERT ${this.vectorTableName} (id, node_type, label, name, properties, embedding)
        VALUES (?, 'entity', ?, ?, ?, TO_REAL_VECTOR(?))
        WITH PRIMARY KEY
      `,
      rowsWithEmbedding
    );
  }

  async upsertRelations(relations: Relation[]): Promise<void> {
    await this.ensureInitialized();
    if (relations.length === 0) return;

    const uniqueRelations = this.uniqueBy(
      relations,
      (rel) => rel.id ?? `${rel.sourceId}_${rel.label}_${rel.targetId}`
    );

    const nodeIds = new Set<string>();
    for (const rel of uniqueRelations) {
      nodeIds.add(rel.sourceId);
      nodeIds.add(rel.targetId);
    }

    const existingNodes = await this.get({ ids: Array.from(nodeIds) });
    const nodeMap = new Map(existingNodes.map((n) => [n.id, n]));

    // Write to RDF graph (backward compat — kept for installations that use SPARQL)
    const lines: string[] = [];
    for (const rel of uniqueRelations) {
      const subj = nodeMap.get(rel.sourceId);
      const obj = nodeMap.get(rel.targetId);
      if (subj && obj) {
        lines.push(this.relationToTriples(rel, subj, obj));
      }
    }

    if (lines.length > 0) {
      const sparql = `INSERT DATA { GRAPH <${this.graphName}> { ${lines.join("\n")} } }`;
      await this.sparqlExecute(sparql).catch((err: any) => {
        // SPARQL may fail if KG Engine is not enabled — log but don't block
        console.warn(`[HanaPropertyGraphStore] SPARQL INSERT for relations failed (non-fatal):`, err?.message ?? err);
      });
    }

    // Write to _VECTORS table for reliable SQL-based querying via getRelMap()
    const relationRows: unknown[][] = [];
    for (const rel of uniqueRelations) {
      const relId = rel.id ?? `${rel.sourceId}_${rel.label}_${rel.targetId}`;
      const safeProps: Record<string, unknown> = {
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        ...(rel.properties ?? {}),
      };
      delete (safeProps as any).kg_nodes;
      delete (safeProps as any).kg_relations;

      relationRows.push([
        relId,
        rel.label,
        `${rel.sourceId} -> ${rel.targetId}`,
        JSON.stringify(safeProps),
        rel.sourceId,
        rel.targetId,
      ]);
    }

    await this.execBatch(
      `
        UPSERT ${this.vectorTableName} (id, node_type, label, name, properties, source_id, target_id)
        VALUES (?, 'relation', ?, ?, ?, ?, ?)
        WITH PRIMARY KEY
      `,
      relationRows
    );
  }

  async get(opts: { ids: string[] }): Promise<LabelledNode[]> {
    await this.ensureInitialized();
    if (opts.ids.length === 0) return [];

    const rows = (await this.exec(
      `SELECT id, label, name, properties FROM ${this.vectorTableName} WHERE id IN (${opts.ids.map(() => "?").join(",")})`,
      opts.ids
    )) as any[];

    return (rows ?? []).map((r) => ({
      id: r.ID ?? r.id,
      label: r.LABEL ?? r.label,
      name: r.NAME ?? r.name,
      properties: JSON.parse(r.PROPERTIES ?? r.properties ?? "{}"),
    }));
  }

  async getRelMap(opts: {
    nodes: LabelledNode[];
    depth?: number;
    limit?: number;
    ignoreRels?: string[];
  }): Promise<Triplet[]> {
    await this.ensureInitialized();
    if (opts.nodes.length === 0) return [];

    const nodeIds = opts.nodes.map((n) => n.id);
    const depth = opts.depth ?? 1;
    const limit = opts.limit ?? 100;
    const ignoreRels = opts.ignoreRels ?? [KG_SOURCE_REL];
    const ignoreRelSet = new Set(ignoreRels);

    const triplets: Triplet[] = [];
    const seenKeys = new Set<string>();
    const nodeMap = new Map(opts.nodes.map((n) => [n.id, n]));

    // --- SQL path: query _VECTORS WHERE node_type='relation' ---
    const placeholders = nodeIds.map(() => "?").join(",");
    const sqlRelQuery = `
      SELECT id, label, name, properties, source_id, target_id
      FROM ${this.vectorTableName}
      WHERE node_type = 'relation'
        AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
      LIMIT ?
    `;
    const sqlParams = [...nodeIds, ...nodeIds, limit];

    try {
      const sqlRows = (await this.exec(sqlRelQuery, sqlParams)) as any[];
      for (const row of sqlRows ?? []) {
        const relLabel = row.LABEL ?? row.label;
        const sourceId = row.SOURCE_ID ?? row.source_id;
        const targetId = row.TARGET_ID ?? row.target_id;

        if (ignoreRelSet.has(relLabel)) continue;

        const key = `${sourceId}|${relLabel}|${targetId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        let subj = nodeMap.get(sourceId);
        let obj = nodeMap.get(targetId);

        if (!subj) {
          subj = { id: sourceId, label: "UNKNOWN", name: sourceId, properties: {} };
        }
        if (!obj) {
          obj = { id: targetId, label: "UNKNOWN", name: targetId, properties: {} };
        }

        const rel: Relation = {
          id: row.ID ?? row.id,
          label: relLabel,
          sourceId,
          targetId,
          properties: JSON.parse(row.PROPERTIES ?? row.properties ?? "{}"),
        };

        triplets.push([subj, rel, obj]);
      }
    } catch (err: any) {
      console.warn(`[HanaPropertyGraphStore] SQL relation query failed (falling back to SPARQL only):`, err?.message ?? err);
    }

    // --- SPARQL path: query RDF graph (backward compat) ---
    try {
      const filterClause = nodeIds
        .map((id) => `CONTAINS(STR(?s), "${encodeURIComponent(id)}") || CONTAINS(STR(?o), "${encodeURIComponent(id)}")`)
        .join(" || ");

      const ignoreFilter = ignoreRels.length > 0
        ? `FILTER(${ignoreRels.map((r) => `!CONTAINS(STR(?p), "${r}")`).join(" && ")})`
        : "";

      const sparql = `
        SELECT ?s ?p ?o
        FROM <${this.graphName}>
        WHERE {
          ?s ?p ?o .
          FILTER(${filterClause})
          ${ignoreFilter}
        }
        LIMIT ${limit}
      `;

      const result = await this.exec(
        `SELECT * FROM SPARQL_TABLE('${sparql.replace(/'/g, "''")}')`
      ) as any[];

      for (const row of result ?? []) {
        const sUri = row.S ?? row.s;
        const pUri = row.P ?? row.p;
        const oUri = row.O ?? row.o;

        const sId = this.extractIdFromUri(sUri);
        const oId = this.extractIdFromUri(oUri);
        const relLabel = this.extractRelLabelFromUri(pUri);

        const key = `${sId}|${relLabel}|${oId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        let subj = nodeMap.get(sId);
        let obj = nodeMap.get(oId);

        if (!subj) {
          subj = { id: sId, label: "UNKNOWN", name: sId, properties: {} };
        }
        if (!obj) {
          obj = { id: oId, label: "UNKNOWN", name: oId, properties: {} };
        }

        const rel: Relation = {
          label: relLabel,
          sourceId: sId,
          targetId: oId,
          properties: {},
        };

        triplets.push([subj, rel, obj]);
      }
    } catch (err: any) {
      // SPARQL may fail if KG Engine is not enabled — log but don't block
      console.warn(`[HanaPropertyGraphStore] SPARQL relation query failed (non-fatal):`, err?.message ?? err);
    }

    return triplets;
  }

  private extractIdFromUri(uri: string): string {
    // URI format: <urn:hkv:graphName:label:id> or just the content without angle brackets
    // The ID is the last segment after the label (second-to-last segment)
    const cleanUri = uri.replace(/^<|>$/g, "");
    const parts = cleanUri.split(":");
    // ID is the last part, decode it
    if (parts.length >= 2) {
      return decodeURIComponent(parts[parts.length - 1]);
    }
    return uri;
  }

  private extractRelLabelFromUri(uri: string): string {
    const match = uri.match(/urn:hkv:rel:(.+)>?$/);
    return match ? match[1].replace(/>$/, "") : uri;
  }

  async delete(opts: { ids: string[] }): Promise<void> {
    await this.ensureInitialized();
    if (opts.ids.length === 0) return;

    for (const id of opts.ids) {
      await this.exec(`DELETE FROM ${this.vectorTableName} WHERE id = ?`, [id]);
    }
  }

  async vectorQuery(query: VectorStoreQuery): Promise<[LabelledNode[], number[]]> {
    await this.ensureInitialized();

    const sql = `
      SELECT id, label, name, properties,
        COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS score
      FROM ${this.vectorTableName}
      WHERE embedding IS NOT NULL
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = (await this.exec(sql, [
      JSON.stringify(query.queryEmbedding),
      query.similarityTopK,
    ])) as any[];

    const nodes: LabelledNode[] = [];
    const scores: number[] = [];

    for (const row of rows ?? []) {
      nodes.push({
        id: row.ID ?? row.id,
        label: row.LABEL ?? row.label,
        name: row.NAME ?? row.name,
        properties: JSON.parse(row.PROPERTIES ?? row.properties ?? "{}"),
      });
      scores.push(row.SCORE ?? row.score ?? 0);
    }

    return [nodes, scores];
  }

  async upsertDocumentNodes(nodes: DocumentNode[]): Promise<void> {
    await this.ensureInitialized();
    if (nodes.length === 0) return;

    const uniqueNodes = this.uniqueBy(nodes, (node) => node.id);
    const docRowsWithEmbedding: unknown[][] = [];
    const docRowsWithoutEmbedding: unknown[][] = [];
    const vectorRowsWithEmbedding: unknown[][] = [];
    const vectorRowsWithoutEmbedding: unknown[][] = [];

    for (const node of uniqueNodes) {
      const safeMetadata = this.sanitizeRecord(node.metadata);
      const metadataJson = JSON.stringify(safeMetadata ?? {});
      const docRow = [node.id, node.text, metadataJson, node.hash ?? null];
      const vectorRow = [node.id, node.id, metadataJson];

      if (node.embedding) {
        const embeddingJson = JSON.stringify(node.embedding);
        docRowsWithEmbedding.push([...docRow, embeddingJson]);
        vectorRowsWithEmbedding.push([...vectorRow, embeddingJson]);
      } else {
        docRowsWithoutEmbedding.push(docRow);
        vectorRowsWithoutEmbedding.push(vectorRow);
      }
    }

    await this.execBatch(
      `
        UPSERT ${this.documentNodesTableName} (id, text, metadata, hash, embedding)
        VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?))
        WITH PRIMARY KEY
      `,
      docRowsWithEmbedding
    );

    await this.execBatch(
      `
        UPSERT ${this.documentNodesTableName} (id, text, metadata, hash, embedding)
        VALUES (?, ?, ?, ?, NULL)
        WITH PRIMARY KEY
      `,
      docRowsWithoutEmbedding
    );

    await this.execBatch(
      `
        UPSERT ${this.vectorTableName} (id, node_type, label, name, properties, embedding)
        VALUES (?, 'document', 'DOCUMENT', ?, ?, TO_REAL_VECTOR(?))
        WITH PRIMARY KEY
      `,
      vectorRowsWithEmbedding
    );

    await this.execBatch(
      `
        UPSERT ${this.vectorTableName} (id, node_type, label, name, properties)
        VALUES (?, 'document', 'DOCUMENT', ?, ?)
        WITH PRIMARY KEY
      `,
      vectorRowsWithoutEmbedding
    );
  }

  async getDocumentNodes(ids: string[]): Promise<DocumentNode[]> {
    await this.ensureInitialized();
    if (ids.length === 0) return [];

    const rows = (await this.exec(
      `SELECT id, text, metadata, hash FROM ${this.documentNodesTableName} WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids
    )) as any[];

    return (rows ?? []).map((r) => ({
      id: r.ID ?? r.id,
      text: r.TEXT ?? r.text,
      metadata: JSON.parse(r.METADATA ?? r.metadata ?? "{}"),
      hash: r.HASH ?? r.hash,
    }));
  }
}
