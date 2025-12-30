import { loadEnv } from "../src/env";

loadEnv();

function parseHostPort(host: string, fallbackPort: number): { host: string; port: number } {
  const idx = host.lastIndexOf(":");
  if (idx > -1 && idx < host.length - 1) {
    const maybePort = Number(host.slice(idx + 1));
    if (!Number.isNaN(maybePort) && maybePort > 0) {
      return { host: host.slice(0, idx), port: maybePort };
    }
  }
  return { host, port: fallbackPort };
}

async function main() {
  const host = process.env.HANA_HOST;
  const fallbackPort = process.env.HANA_PORT ? Number(process.env.HANA_PORT) : 443;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (!host || !user || !password) {
    console.log("HANA_HOST/HANA_USER/HANA_PASSWORD not set. Copy .env.example to .env.local and fill them.");
    process.exit(0);
  }

  const { host: hostOnly, port } = parseHostPort(host, fallbackPort);

  let hana: any;
  try {
    hana = await import("@sap/hana-client");
  } catch {
    console.error(
      "@sap/hana-client is not available. If you use pnpm, you likely need to run `pnpm approve-builds` and reinstall so native modules can build."
    );
    process.exit(2);
  }

  const conn = hana.createConnection();

  await new Promise<void>((resolve, reject) => {
    conn.connect(
      {
        serverNode: `${hostOnly}:${port}`,
        uid: user,
        pwd: password,
        encrypt: true,
        sslValidateCertificate: true
      },
      (err: unknown) => (err ? reject(err) : resolve())
    );
  });

  const sql = "SELECT CURRENT_TIMESTAMP AS now FROM DUMMY";

  const rows: any[] = await new Promise((resolve, reject) => {
    conn.exec(sql, (err: unknown, result: any) => (err ? reject(err) : resolve(result)));
  });

  console.log("HANA connection ok. now:", rows?.[0]?.NOW ?? rows?.[0]?.now);
  conn.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("HANA validation failed:", err);
  process.exit(1);
});
