import { createHash } from "crypto";

export function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function escapeSparqlLiteral(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

export function resolveSqlBatchSize(configured?: number): number {
  const raw = configured ?? Number(process.env.HANA_KGVECTOR_SQL_BATCH_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return 500;
  return Math.floor(raw);
}

export function safeJsonParse(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
