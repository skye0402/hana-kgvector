import type { HanaConnection } from "../hana/types";
import type { PropertyGraphStore, VectorStoreQuery } from "./property-graph-store";
import type { EntityNode, Relation, Triplet, LabelledNode } from "./types";
import { TRIPLET_SOURCE_KEY, KG_SOURCE_REL } from "./types";

type LlamaNode = {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
  hash?: string;
};

export interface HanaPropertyGraphStoreOptions {
  graphName: string;
  vectorTableName?: string;
  llamaNodesTableName?: string;
  /** Optional, unused for dimensionless REAL_VECTOR columns (kept for backward compat logging). */
  vectorDimension?: number;
  /** If true, will DROP and recreate tables on init (intended for tests/dev only). */
  resetTables?: boolean;
}

export class HanaPropertyGraphStore implements PropertyGraphStore {
  private readonly conn: HanaConnection;
  private readonly graphName: string;
  private readonly vectorTableName: string;
  private readonly llamaNodesTableName: string;
  private readonly resetTables: boolean;
  private initialized = false;

  readonly supportsVectorQueries = true;
  readonly supportsStructuredQueries = true;

  constructor(conn: HanaConnection, options: HanaPropertyGraphStoreOptions) {
    this.conn = conn;
    this.graphName = options.graphName;
    this.vectorTableName = options.vectorTableName ?? `${options.graphName.replace(/[^a-zA-Z0-9]/g, "_")}_VECTORS`;
    this.llamaNodesTableName = options.llamaNodesTableName ?? `${options.graphName.replace(/[^a-zA-Z0-9]/g, "_")}_NODES`;
    this.resetTables = options.resetTables ?? false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Optional destructive reset intended for tests/dev. This is OFF by default.
    if (this.resetTables) {
      await this.exec(`DROP TABLE ${this.vectorTableName}`).catch(() => {});
      await this.exec(`DROP TABLE ${this.llamaNodesTableName}`).catch(() => {});
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

    const createLlamaTable = `
      CREATE COLUMN TABLE ${this.llamaNodesTableName} (
        id NVARCHAR(512) PRIMARY KEY,
        text NCLOB,
        metadata NCLOB,
        hash NVARCHAR(64),
        embedding REAL_VECTOR
      )
    `;
    await this.exec(createLlamaTable).catch((err: any) => {
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
        const escaped = typeof value === "string" ? this.escapeLiteral(value) : String(value);
        lines.push(`${uri} <urn:hkv:prop:${key}> "${escaped}" .`);
      }
    }

    return lines.join("\n");
  }

  private escapeLiteral(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  async upsertNodes(nodes: EntityNode[]): Promise<void> {
    await this.ensureInitialized();
    if (nodes.length === 0) return;

    const triples = nodes.map((n) => this.entityToTriples(n)).join("\n");
    const sparql = `INSERT DATA { GRAPH <${this.graphName}> { ${triples} } }`;
    await this.sparqlExecute(sparql);

    for (const node of nodes) {
      if (node.embedding) {
        // Defensive: prevent circular references from being serialized into NCLOB
        const safeProps: Record<string, unknown> = { ...(node.properties ?? {}) };
        delete (safeProps as any).kg_nodes;
        delete (safeProps as any).kg_relations;

        const sql = `
          UPSERT ${this.vectorTableName} (id, node_type, label, name, properties, embedding)
          VALUES (?, 'entity', ?, ?, ?, TO_REAL_VECTOR(?))
          WITH PRIMARY KEY
        `;
        await this.exec(sql, [
          node.id,
          node.label,
          node.name,
          JSON.stringify(safeProps),
          JSON.stringify(node.embedding),
        ]);
      }
    }
  }

  async upsertRelations(relations: Relation[]): Promise<void> {
    await this.ensureInitialized();
    if (relations.length === 0) return;

    const nodeIds = new Set<string>();
    for (const rel of relations) {
      nodeIds.add(rel.sourceId);
      nodeIds.add(rel.targetId);
    }

    const existingNodes = await this.get({ ids: Array.from(nodeIds) });
    const nodeMap = new Map(existingNodes.map((n) => [n.id, n]));

    const lines: string[] = [];
    for (const rel of relations) {
      const subj = nodeMap.get(rel.sourceId);
      const obj = nodeMap.get(rel.targetId);
      if (subj && obj) {
        lines.push(this.relationToTriples(rel, subj, obj));
      }
    }

    if (lines.length > 0) {
      const sparql = `INSERT DATA { GRAPH <${this.graphName}> { ${lines.join("\n")} } }`;
      await this.sparqlExecute(sparql);
    }
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

    const triplets: Triplet[] = [];
    const nodeMap = new Map(opts.nodes.map((n) => [n.id, n]));

    for (const row of result ?? []) {
      const sUri = row.S ?? row.s;
      const pUri = row.P ?? row.p;
      const oUri = row.O ?? row.o;

      const sId = this.extractIdFromUri(sUri);
      const oId = this.extractIdFromUri(oUri);
      const relLabel = this.extractRelLabelFromUri(pUri);

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

  async upsertLlamaNodes(nodes: LlamaNode[]): Promise<void> {
    await this.ensureInitialized();
    for (const node of nodes) {
      // Remove circular references from metadata before serialization
      const { metadata, ...rest } = node;
      const safeMetadata = { ...metadata };
      delete (safeMetadata as any).kg_nodes;
      delete (safeMetadata as any).kg_relations;

      const sql = `
        UPSERT ${this.llamaNodesTableName} (id, text, metadata, hash, embedding)
        VALUES (?, ?, ?, ?, ${node.embedding ? "TO_REAL_VECTOR(?)" : "NULL"})
        WITH PRIMARY KEY
      `;
      const params: unknown[] = [
        node.id,
        node.text,
        JSON.stringify(safeMetadata ?? {}),
        node.hash ?? null,
      ];
      if (node.embedding) {
        params.push(JSON.stringify(node.embedding));
      }
      await this.exec(sql, params);
    }
  }

  async getLlamaNodes(ids: string[]): Promise<LlamaNode[]> {
    await this.ensureInitialized();
    if (ids.length === 0) return [];

    const rows = (await this.exec(
      `SELECT id, text, metadata, hash FROM ${this.llamaNodesTableName} WHERE id IN (${ids.map(() => "?").join(",")})`,
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
