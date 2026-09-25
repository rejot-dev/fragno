import { createServer, type RequestListener, type Server } from "node:http";

export type NodeBackofficeListener = {
  host: string;
  server: Server;
};

function formatNodeBackofficeListenUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function listenOnNodeBackofficeHost(input: {
  requestListener: RequestListener;
  host: string;
  port: number;
}): Promise<NodeBackofficeListener> {
  const server = createServer(input.requestListener);
  return new Promise((resolve, reject) => {
    function rejectListen(error: Error) {
      reject(error);
    }

    server.once("error", rejectListen);
    server.listen(input.port, input.host, () => {
      server.off("error", rejectListen);
      resolve({ host: input.host, server });
    });
  });
}

/** Starts every configured Node Backoffice listener or closes all successfully bound listeners. */
export async function startNodeBackofficeListeners(input: {
  requestListener: RequestListener;
  hosts: readonly string[];
  port: number;
}): Promise<NodeBackofficeListener[]> {
  const listeners: NodeBackofficeListener[] = [];
  try {
    for (const host of input.hosts) {
      listeners.push(
        await listenOnNodeBackofficeHost({
          requestListener: input.requestListener,
          host,
          port: input.port,
        }),
      );
    }
    return listeners;
  } catch (cause) {
    await stopNodeBackofficeListeners(listeners);
    const failedHost = input.hosts[listeners.length];
    const errorCode =
      cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE"
        ? "BACKOFFICE_LOOPBACK_PORT_CONFLICT"
        : "BACKOFFICE_SERVER_BIND_FAILED";
    throw new Error(
      `${errorCode}: Node Backoffice must bind every configured host (${input.hosts.join(
        ", ",
      )}) on port ${input.port}; failed to bind ${failedHost}.`,
      { cause },
    );
  }
}

/** Stops all HTTP listeners owned by one Node Backoffice server process. */
export async function stopNodeBackofficeListeners(
  listeners: readonly NodeBackofficeListener[],
): Promise<void> {
  await Promise.all(
    listeners.map(
      ({ server }) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
}

/** Formats the listening addresses shown after Node Backoffice startup. */
export function formatNodeBackofficeListenUrls(
  listeners: readonly NodeBackofficeListener[],
  port: number,
): string {
  return listeners.map(({ host }) => formatNodeBackofficeListenUrl(host, port)).join(", ");
}
