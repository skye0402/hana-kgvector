import type { HanaConnection } from "./types";
import { hanaExec } from "./connection";

export type HanaKgGraphTableSuffix = "VECTORS" | "NODES" | "IMAGES";

export type GraphTables = {
  vectorsTable: string;
  nodesTable: string;
  imagesTable: string;
};

export type HanaKgGraphInfo = {
  graphName: string;
  hasVectors: boolean;
  hasNodes: boolean;
  hasImages: boolean;
  vectorsCount?: number;
  nodesCount?: number;
  imagesCount?: number;
};

export function getGraphTables(graphName: string): GraphTables {
  return {
    vectorsTable: `${graphName}_VECTORS`,
    nodesTable: `${graphName}_NODES`,
    imagesTable: `${graphName}_IMAGES`,
  };
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeRequirement(req: HanaKgGraphTableSuffix): HanaKgGraphTableSuffix {
  return req.toUpperCase() as HanaKgGraphTableSuffix;
}

export async function listGraphs(
  conn: HanaConnection,
  opts?: {
    schema?: string;
    require?: HanaKgGraphTableSuffix[];
    includeCounts?: boolean;
    limit?: number;
  }
): Promise<HanaKgGraphInfo[]> {
  const schemaFilter = opts?.schema ? ` = '${escapeSqlStringLiteral(opts.schema)}'` : " = CURRENT_SCHEMA";

  // Discover by our naming convention in a single pass.
  // Note: `_` is a wildcard in LIKE, so we must escape it.
  const rows = (await hanaExec<any[]>(
    conn,
    `SELECT TABLE_NAME
     FROM SYS.TABLES
     WHERE SCHEMA_NAME${schemaFilter}
       AND (
         TABLE_NAME LIKE '%\\_VECTORS' ESCAPE '\\'
         OR TABLE_NAME LIKE '%\\_NODES' ESCAPE '\\'
         OR TABLE_NAME LIKE '%\\_IMAGES' ESCAPE '\\'
       )`
  )) as Array<{ TABLE_NAME?: string; table_name?: string }>;

  const tableNames = new Set(
    (rows ?? []).map((r) => String(r.TABLE_NAME ?? r.table_name ?? "").toUpperCase()).filter(Boolean)
  );

  const stems = new Set<string>();
  for (const t of tableNames) {
    if (t.endsWith("_VECTORS")) {
      stems.add(t.slice(0, -"_VECTORS".length));
    }
  }

  const infos: HanaKgGraphInfo[] = [];
  for (const stem of stems) {
    const { vectorsTable, nodesTable, imagesTable } = getGraphTables(stem);
    infos.push({
      graphName: stem,
      hasVectors: tableNames.has(vectorsTable),
      hasNodes: tableNames.has(nodesTable),
      hasImages: tableNames.has(imagesTable),
    });
  }

  if (opts?.includeCounts) {
    // Only count tables that exist; use quoted identifiers to be robust.
    // NOTE: Table names come from SYS.TABLES results, so this is not user input.
    const schemaName = opts?.schema ? String(opts.schema).toUpperCase() : undefined;

    const countTable = async (tableName: string): Promise<number> => {
      const fq = schemaName
        ? `"${schemaName.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`
        : `"${tableName.replace(/"/g, '""')}"`;
      const res = (await hanaExec<any[]>(conn, `SELECT COUNT(*) AS CNT FROM ${fq}`)) as any[];
      const row = res?.[0];
      const cnt = row?.CNT ?? row?.cnt ?? Object.values(row ?? {})[0];
      return Number(cnt ?? 0);
    };

    for (const info of infos) {
      const { vectorsTable, nodesTable, imagesTable } = getGraphTables(info.graphName);

      if (info.hasVectors) {
        info.vectorsCount = await countTable(vectorsTable);
      }
      if (info.hasNodes) {
        info.nodesCount = await countTable(nodesTable);
      }
      if (info.hasImages) {
        info.imagesCount = await countTable(imagesTable);
      }
    }
  }

  const requireList = (opts?.require ?? []).map(normalizeRequirement);
  const filtered = requireList.length
    ? infos.filter((i) =>
        requireList.every((req) => {
          if (req === "VECTORS") return i.hasVectors;
          if (req === "NODES") return i.hasNodes;
          if (req === "IMAGES") return i.hasImages;
          return false;
        })
      )
    : infos;

  filtered.sort((a, b) => a.graphName.localeCompare(b.graphName));

  if (opts?.limit !== undefined) {
    return filtered.slice(0, Math.max(0, opts.limit));
  }

  return filtered;
}
