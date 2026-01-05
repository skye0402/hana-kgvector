import dotenv from "dotenv";

import { createHanaConnection } from "../src/hana/connection";
import { listGraphs } from "../src/hana/graph-discovery";

dotenv.config({ path: ".env.local" });

function safeFail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const host = process.env.HANA_HOST;
  const port = process.env.HANA_PORT ? Number(process.env.HANA_PORT) : undefined;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;
  const schema = process.env.HANA_SCHEMA;

  if (!host || !user || !password) {
    safeFail(
      "Missing HANA credentials. Ensure .env.local sets HANA_HOST, HANA_USER, HANA_PASSWORD (and optionally HANA_SCHEMA)."
    );
  }

  console.log(`Connecting to HANA (host=${host}${port ? `:${port}` : ""}, schema=${schema || "<current>"})...`);
  const conn = await createHanaConnection({ host, port, user, password });

  const graphs = await listGraphs(conn, {
    schema,
    // Ignore IMAGES by default (app-managed).
    require: ["VECTORS", "NODES"],
  });

  if (graphs.length === 0) {
    console.log("No graphs found (no *_VECTORS tables discovered).");
    process.exit(0);
  }

  console.log(`Found ${graphs.length} graph(s):`);
  for (const g of graphs) {
    console.log(
      `- ${g.graphName} (hasVectors=${g.hasVectors}, hasNodes=${g.hasNodes}, hasImages=${g.hasImages})`
    );
  }

  process.exit(0);
}

main().catch(() => {
  // Avoid dumping raw error objects which may contain sensitive info.
  console.error(
    "Graph discovery failed. Check HANA connectivity/credentials and permissions to read SYS.TABLES."
  );
  process.exit(1);
});
