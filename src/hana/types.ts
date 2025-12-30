export type HanaConnectionConfig = {
  host: string;
  port?: number;
  user: string;
  password: string;
  encrypt?: boolean;
  sslValidateCertificate?: boolean;
};

export type HanaConnection = {
  connect: (params: Record<string, unknown>, cb: (err?: unknown) => void) => void;
  exec: (sql: string, cb: (err: unknown, result: unknown) => void) => void;
  disconnect: () => void;
};
