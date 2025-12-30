export function parseHostPort(
  host: string,
  fallbackPort: number
): { host: string; port: number } {
  const idx = host.lastIndexOf(":");
  if (idx > -1 && idx < host.length - 1) {
    const maybePort = Number(host.slice(idx + 1));
    if (!Number.isNaN(maybePort) && maybePort > 0) {
      return { host: host.slice(0, idx), port: maybePort };
    }
  }

  return { host, port: fallbackPort };
}
