import type { HanaConnection } from "../hana/types";
import type { Space, SpaceCreateInput } from "./types";

export class SpaceManager {
  private readonly conn: HanaConnection;
  private readonly spacesTable: string;

  constructor(conn: HanaConnection, options?: { spacesTable?: string }) {
    this.conn = conn;
    this.spacesTable = options?.spacesTable ?? "HKV_SPACES";
  }

  async ensureSchema(): Promise<void> {
    const sql = `
CREATE TABLE ${this.spacesTable} (
  id NVARCHAR(128) PRIMARY KEY,
  name NVARCHAR(255) NOT NULL,
  description NCLOB,
  rdf_graph_name NVARCHAR(512) NOT NULL,
  vector_table_name NVARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

    try {
      await new Promise<void>((resolve, reject) => {
        this.conn.exec(sql, (err: unknown) => (err ? reject(err) : resolve()));
      });
    } catch {
      // Table likely exists; ignore.
    }
  }

  private makeDefaults(spaceId: string): { rdfGraphName: string; vectorTableName: string } {
    return {
      rdfGraphName: `urn:hana-kgvector:${spaceId}`,
      vectorTableName: `HKV_VECTORS_${spaceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    };
  }

  async create(input: SpaceCreateInput): Promise<Space> {
    await this.ensureSchema();

    const defaults = this.makeDefaults(input.id);

    const sql = `
INSERT INTO ${this.spacesTable} (id, name, description, rdf_graph_name, vector_table_name)
VALUES (?, ?, ?, ?, ?)
`;

    await new Promise<void>((resolve, reject) => {
      (this.conn as any).exec(
        sql,
        [input.id, input.name, input.description ?? null, defaults.rdfGraphName, defaults.vectorTableName],
        (err: unknown) => (err ? reject(err) : resolve())
      );
    });

    return {
      id: input.id,
      name: input.name,
      description: input.description,
      rdfGraphName: defaults.rdfGraphName,
      vectorTableName: defaults.vectorTableName,
      createdAt: new Date()
    };
  }

  async list(): Promise<Space[]> {
    await this.ensureSchema();

    const sql = `SELECT id, name, description, rdf_graph_name, vector_table_name, created_at FROM ${this.spacesTable}`;

    const rows = await new Promise<any[]>((resolve, reject) => {
      this.conn.exec(sql, (err: unknown, result: any) => (err ? reject(err) : resolve(result)));
    });

    return (rows ?? []).map((r) => ({
      id: String(r.ID ?? r.id),
      name: String(r.NAME ?? r.name),
      description: (r.DESCRIPTION ?? r.description) ? String(r.DESCRIPTION ?? r.description) : undefined,
      rdfGraphName: String(r.RDF_GRAPH_NAME ?? r.rdf_graph_name),
      vectorTableName: String(r.VECTOR_TABLE_NAME ?? r.vector_table_name),
      createdAt: new Date(r.CREATED_AT ?? r.created_at ?? Date.now())
    }));
  }
}
