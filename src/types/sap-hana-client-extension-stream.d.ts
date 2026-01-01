declare module "@sap/hana-client/extension/Stream" {
  export type ProcStatement = {
    exec: (
      params: unknown[] | Record<string, unknown>,
      cb: (err: unknown, scalarParams?: Record<string, unknown>, ...rest: unknown[]) => void
    ) => void;
    drop?: (cb: (err?: unknown) => void) => void;
  };

  export function createProcStatement(
    connection: unknown,
    sql: string,
    cb: (err: unknown, stmt?: ProcStatement) => void
  ): void;
}
