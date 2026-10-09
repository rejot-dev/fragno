import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";

// Leave the process supervisor two seconds for runtime cleanup before its ten-second hard stop.
const NODE_BACKOFFICE_RESPONSE_DRAIN_TIMEOUT_MS = 8_000;

export type NodeBackofficeListener = {
  host: string;
  server: Server;
  activeResponses: Set<ServerResponse>;
  stopping: boolean;
};

function formatNodeBackofficeListenUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function listenOnNodeBackofficeHost(input: {
  requestListener: RequestListener;
  host: string;
  port: number;
}): Promise<NodeBackofficeListener> {
  const activeResponses = new Set<ServerResponse>();
  const listener: Omit<NodeBackofficeListener, "server"> = {
    host: input.host,
    activeResponses,
    stopping: false,
  };
  const server = createServer((request, response) => {
    activeResponses.add(response);
    const releaseResponse = () => {
      activeResponses.delete(response);
      // `server.close()` only closes connections idle when it is called. A keep-alive connection
      // whose response finishes during shutdown would otherwise hold the drain until the deadline.
      if (listener.stopping) {
        server.closeIdleConnections();
      }
    };
    response.once("finish", releaseResponse);
    response.once("close", releaseResponse);
    input.requestListener(request, response);
  });
  return new Promise((resolve, reject) => {
    function rejectListen(error: Error) {
      reject(error);
    }

    server.once("error", rejectListen);
    server.listen(input.port, input.host, () => {
      server.off("error", rejectListen);
      resolve(Object.assign(listener, { server }));
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

function closeNodeBackofficeListener(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function forceCloseNodeBackofficeResponses(listeners: readonly NodeBackofficeListener[]): void {
  for (const { server, activeResponses } of listeners) {
    for (const response of activeResponses) {
      response.destroy();
    }
    server.closeAllConnections();
  }
}

/** Drains ordinary HTTP responses, then force-closes streams that outlive the shutdown deadline. */
export async function stopNodeBackofficeListeners(
  listeners: readonly NodeBackofficeListener[],
  forceCloseAfterMs = NODE_BACKOFFICE_RESPONSE_DRAIN_TIMEOUT_MS,
): Promise<void> {
  for (const listener of listeners) {
    listener.stopping = true;
  }
  const listenersStopped = Promise.all(
    listeners.map(({ server }) => closeNodeBackofficeListener(server)),
  );
  let forceCloseTimer: NodeJS.Timeout | null = null;
  const forceCloseDeadline = new Promise<"deadline">((resolve) => {
    forceCloseTimer = setTimeout(() => {
      resolve("deadline");
    }, forceCloseAfterMs);
    forceCloseTimer.unref();
  });

  try {
    const outcome = await Promise.race([
      listenersStopped.then(() => "drained" as const),
      forceCloseDeadline,
    ]);
    if (outcome === "drained") {
      return;
    }

    forceCloseNodeBackofficeResponses(listeners);
    await listenersStopped;
  } finally {
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer);
    }
  }
}

/** Formats the listening addresses shown after Node Backoffice startup. */
export function formatNodeBackofficeListenUrls(
  listeners: readonly NodeBackofficeListener[],
  port: number,
): string {
  return listeners.map(({ host }) => formatNodeBackofficeListenUrl(host, port)).join(", ");
}
