import { loadEnv } from "./env";
import { createHanaConnection } from "./hana/connection";
import { HanaSparqlStore } from "./hana/sparql-store";
import { HanaVectorStore } from "./hana/vector-store";
import type { HanaConnection, HanaConnectionConfig } from "./hana/types";
import { SpaceManager } from "./spaces/space-manager";

export type HanaKGVectorConfig = {
  hana: HanaConnectionConfig;
};

export class HanaKGVector {
  private readonly conn: HanaConnection;

  public readonly sparql: HanaSparqlStore;
  public readonly spaces: SpaceManager;

  private constructor(conn: HanaConnection) {
    this.conn = conn;
    this.sparql = new HanaSparqlStore(conn);
    this.spaces = new SpaceManager(conn);
  }

  static async connect(config: HanaKGVectorConfig): Promise<HanaKGVector> {
    const conn = await createHanaConnection(config.hana);
    return new HanaKGVector(conn);
  }

  static async connectFromEnv(): Promise<HanaKGVector> {
    loadEnv();

    const host = process.env.HANA_HOST;
    const user = process.env.HANA_USER;
    const password = process.env.HANA_PASSWORD;

    if (!host || !user || !password) {
      throw new Error(
        "Missing HANA credentials. Set HANA_HOST, HANA_USER, HANA_PASSWORD in .env.local."
      );
    }

    const port = process.env.HANA_PORT ? Number(process.env.HANA_PORT) : undefined;

    return await HanaKGVector.connect({
      hana: {
        host,
        port,
        user,
        password
      }
    });
  }

  vectorStore(options: { tableName: string }): HanaVectorStore {
    return new HanaVectorStore(this.conn, { tableName: options.tableName });
  }

  async close(): Promise<void> {
    this.conn.disconnect();
  }
}
