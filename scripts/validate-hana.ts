import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

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
    hana = hana.default || hana;
  } catch {
    console.error(
      "@sap/hana-client is not available. If you use pnpm, you likely need to run `pnpm approve-builds` and reinstall so native modules can build."
    );
    process.exit(2);
  }

  const conn = hana.createConnection();

  try {
    await new Promise<void>((resolve, reject) => {
      conn.connect(
        {
          serverNode: `${hostOnly}:${port}`,
          uID: user,
          pwd: password,
          encrypt: "true",
          sslValidateCertificate: "true"
        },
        (err: unknown) => (err ? reject(err) : resolve())
      );
    });
  } catch {
    console.error(
      "HANA validation failed to connect. Check: (1) host/port reachable, (2) user/password correct, (3) network allowlist/VPN/Cloud Connector as needed."
    );
    process.exit(1);
  }

  const sql = "SELECT CURRENT_TIMESTAMP AS now FROM DUMMY";

  let rows: any[];
  try {
    rows = await new Promise((resolve, reject) => {
      conn.exec(sql, (err: unknown, result: any) => (err ? reject(err) : resolve(result)));
    });
  } catch {
    console.error(
      "HANA validation connected but query failed. Check that the user has basic SELECT privileges (DUMMY) and connection is stable."
    );
    conn.disconnect();
    process.exit(1);
  }

  console.log("HANA connection ok. now:", rows?.[0]?.NOW ?? rows?.[0]?.now);
  conn.disconnect();
  process.exit(0);
}

main().catch((err) => {
  // Avoid dumping raw error objects which may contain sensitive info.
  console.error("HANA validation failed (unexpected error). See previous output for guidance.");
  console.error("Error details:", err);
  process.exit(1);
});
