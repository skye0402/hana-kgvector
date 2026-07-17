import type { HanaConnection } from "../hana/types";
import { hanaExec } from "../hana/connection";
import type { NativeGraphInfo } from "./types";
import { escapeSqlStringLiteral } from "./util";

export async function listNativeGraphs(
  conn: HanaConnection,
  opts?: { schema?: string; includeCounts?: boolean; limit?: number }
): Promise<NativeGraphInfo[]> {
  const schemaFilter = opts?.schema ? ` = '${escapeSqlStringLiteral(opts.schema)}'` : " = CURRENT_SCHEMA";
  const rows = await hanaExec<any[]>(conn, `
    SELECT TABLE_NAME
    FROM SYS.TABLES
    WHERE SCHEMA_NAME${schemaFilter}
      AND TABLE_NAME LIKE '%\\_CHUNKS' ESCAPE '\\'
    ORDER BY TABLE_NAME
  `);

  const infos: NativeGraphInfo[] = [];
  for (const row of rows ?? []) {
    const tableName = String(row.TABLE_NAME ?? row.table_name ?? "");
    if (!tableName.endsWith("_CHUNKS")) continue;
    const graphName = tableName.slice(0, -"_CHUNKS".length);
    const info: NativeGraphInfo = { graphName, hasChunks: true };
    if (opts?.includeCounts) {
      const countRows = await hanaExec<any[]>(conn, `SELECT COUNT(*) AS count FROM "${tableName.replace(/"/g, '""')}"`);
      info.chunksCount = Number(countRows?.[0]?.COUNT ?? countRows?.[0]?.count ?? 0);
    }
    infos.push(info);
    if (opts?.limit && infos.length >= opts.limit) break;
  }

  return infos;
}
