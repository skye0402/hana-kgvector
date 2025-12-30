import type { HanaConnection } from "./types";

export type SparqlExecuteResult = unknown;

export class HanaSparqlStore {
  private readonly conn: HanaConnection;

  constructor(conn: HanaConnection) {
    this.conn = conn;
  }

  async execute(options: {
    sparql: string;
    headers?: string;
    defaultGraphUri?: string;
  }): Promise<SparqlExecuteResult> {
    const headerLines: string[] = [];

    if (options.defaultGraphUri) {
      headerLines.push(`rqx-default-graph-uri: ${options.defaultGraphUri}`);
    }

    if (options.headers) {
      headerLines.push(options.headers.trim());
    }

    const hdrs = headerLines.length ? `${headerLines.join("\r\n")}\r\n` : "";

    const sql = "CALL SPARQL_EXECUTE(?, ?, ?, ?)";

    return await new Promise((resolve, reject) => {
      // @sap/hana-client supports conn.exec with parameter arrays.
      // We intentionally keep the result as unknown; callers can parse the XML/JSON depending on HANA return mode.
      (this.conn as any).exec(sql, [options.sparql, hdrs, "", null], (err: unknown, result: unknown) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async loadTurtle(options: {
    turtle: string;
    graphName: string;
    filename?: string;
  }): Promise<SparqlExecuteResult> {
    const requestHdrs = [
      "rqx-load-protocol: true",
      options.filename ? `rqx-load-filename: ${options.filename}` : undefined,
      `rqx-load-graphname: ${options.graphName}`
    ]
      .filter(Boolean)
      .join("\r\n");

    return await this.execute({ sparql: options.turtle, headers: requestHdrs });
  }
}
