import { parseHostPort } from "./parse-host-port";
import type { HanaConnection, HanaConnectionConfig } from "./types";

export async function createHanaConnection(
  config: HanaConnectionConfig
): Promise<HanaConnection> {
  let hana: any;
  try {
    const hanaModule = await import("@sap/hana-client");
    hana = (hanaModule as any).default || hanaModule;
  } catch {
    throw new Error(
      "@sap/hana-client is not available. Ensure it is installed and pnpm build scripts are approved (pnpm approve-builds)."
    );
  }

  const fallbackPort = config.port ?? 443;
  const { host, port } = parseHostPort(config.host, fallbackPort);

  const conn: HanaConnection = hana.createConnection();

  await new Promise<void>((resolve, reject) => {
    conn.connect(
      {
        serverNode: `${host}:${port}`,
        uid: config.user,
        pwd: config.password,
        encrypt: config.encrypt ?? true,
        sslValidateCertificate: config.sslValidateCertificate ?? true
      },
      (err?: unknown) => (err ? reject(err) : resolve())
    );
  });

  return conn;
}

export async function hanaExec<T = unknown>(
  conn: HanaConnection,
  sql: string
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    conn.exec(sql, (err: unknown, result: unknown) => {
      if (err) return reject(err);
      resolve(result as T);
    });
  });
}
