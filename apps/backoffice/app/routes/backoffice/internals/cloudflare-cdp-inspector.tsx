import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { z } from "zod";

import { BackofficeStatusLight, FormContainer, FormField } from "@/components/backoffice";

const cdpMessageSchema = z.union([
  z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    method: z.string(),
    params: z.unknown().optional(),
  }),
]);

type CdpMessage = z.infer<typeof cdpMessageSchema>;
type CdpEvent = Extract<CdpMessage, { method: string }>;
type PendingCommand = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type PageOverview = {
  title: string;
  url: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  document: {
    width: number;
    height: number;
  };
  language: string;
  userAgent: string;
};

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
};

type StorageSnapshot = {
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};

type PerformanceMetric = {
  name: string;
  value: number;
};

type AccessibilityNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
};

type ConsoleEntry = {
  id: number;
  timestamp: string;
  method: string;
  summary: string;
};

const primaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-accent-fg)] uppercase transition-[border-color,opacity,scale] hover:border-[color:var(--bo-accent-strong)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClassName =
  "inline-flex min-h-9 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[border-color,color,scale] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
const controlClassName =
  "min-h-10 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-sm text-[var(--bo-fg)] outline-none transition-colors focus:border-[color:var(--bo-accent)]";

class CdpConnection {
  readonly #pendingCommands = new Map<number, PendingCommand>();
  readonly #eventListeners = new Set<(event: CdpEvent) => void>();
  readonly #socket: WebSocket;
  #nextCommandId = 1;

  constructor(webSocketDebuggerUrl: string, onClose: () => void) {
    this.#socket = new WebSocket(webSocketDebuggerUrl);
    this.#socket.addEventListener("message", (event) => {
      this.#receiveMessage(event.data);
    });
    this.#socket.addEventListener("close", () => {
      this.#rejectPendingCommands(new Error("The CDP WebSocket closed."));
      onClose();
    });
  }

  async open() {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.#socket.readyState >= WebSocket.CLOSING) {
      throw new Error("The CDP WebSocket closed before the connection was established.");
    }

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Could not connect to the target's CDP WebSocket."));
      };
      const handleClose = () => {
        cleanup();
        reject(new Error("The CDP WebSocket closed before the connection was established."));
      };
      const cleanup = () => {
        this.#socket.removeEventListener("open", handleOpen);
        this.#socket.removeEventListener("error", handleError);
        this.#socket.removeEventListener("close", handleClose);
      };

      this.#socket.addEventListener("open", handleOpen);
      this.#socket.addEventListener("error", handleError);
      this.#socket.addEventListener("close", handleClose);
    });
  }

  close() {
    this.#socket.close();
  }

  onEvent(listener: (event: CdpEvent) => void) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async send<TResult>(method: string, params: Record<string, unknown> = {}) {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Connect to the target before sending CDP commands.");
    }

    const id = this.#nextCommandId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.#pendingCommands.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });

    // CDP method results are trusted against the command-specific protocol contract at this boundary.
    return result as TResult;
  }

  #receiveMessage(rawMessage: unknown) {
    if (typeof rawMessage !== "string") {
      this.#failProtocol(new Error("The CDP WebSocket returned a non-text message."));
      return;
    }

    let decodedMessage: unknown;
    try {
      decodedMessage = JSON.parse(rawMessage);
    } catch (cause) {
      this.#failProtocol(new Error("The CDP WebSocket returned invalid JSON.", { cause }));
      return;
    }

    const parsedMessage = cdpMessageSchema.safeParse(decodedMessage);
    if (!parsedMessage.success) {
      this.#failProtocol(new Error("The CDP WebSocket returned an invalid protocol message."));
      return;
    }

    const message = parsedMessage.data;
    if ("method" in message) {
      for (const listener of this.#eventListeners) {
        listener(message);
      }
      return;
    }

    const pendingCommand = this.#pendingCommands.get(message.id);
    if (!pendingCommand) {
      return;
    }

    this.#pendingCommands.delete(message.id);
    if (message.error) {
      pendingCommand.reject(new Error(`${message.error.message} (${message.error.code})`));
      return;
    }

    pendingCommand.resolve(message.result);
  }

  #failProtocol(error: Error) {
    this.#rejectPendingCommands(error);
    this.#socket.close();
  }

  #rejectPendingCommands(error: Error) {
    for (const command of this.#pendingCommands.values()) {
      command.reject(error);
    }
    this.#pendingCommands.clear();
  }
}

const summarizeEvent = (event: CdpEvent) => {
  const params = event.params as Record<string, unknown> | undefined;

  if (event.method === "Network.requestWillBeSent") {
    const request = params?.request as { method?: string; url?: string } | undefined;
    return `${request?.method ?? "GET"} ${request?.url ?? "Unknown URL"}`;
  }

  if (event.method === "Runtime.consoleAPICalled") {
    const type = typeof params?.type === "string" ? params.type : "console";
    const args = Array.isArray(params?.args) ? params.args : [];
    const values = args.map((argument) => {
      const remoteObject = argument as { value?: unknown; description?: string };
      return remoteObject.value ?? remoteObject.description ?? "[value]";
    });
    return `${type}: ${values.map(String).join(" ")}`;
  }

  if (event.method === "Runtime.exceptionThrown") {
    const exceptionDetails = params?.exceptionDetails as { text?: string } | undefined;
    return exceptionDetails?.text ?? "Uncaught exception";
  }

  if (event.method === "Log.entryAdded") {
    const entry = params?.entry as { level?: string; text?: string } | undefined;
    return `${entry?.level ?? "log"}: ${entry?.text ?? "Unknown log entry"}`;
  }

  return event.method;
};

const storageExpression = `(() => ({
  origin: location.origin,
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
}))()`;

const overviewExpression = `(() => ({
  title: document.title,
  url: location.href,
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  },
  document: {
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  },
  language: navigator.language,
  userAgent: navigator.userAgent,
}))()`;

function JsonResult({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto border border-[color:var(--bo-border)] bg-[#08110f] p-3 text-xs leading-5 text-[#a8d8c7]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function CommandOutput({
  screenshotUrl,
  screenshotAlt,
  result,
}: {
  screenshotUrl: string | null;
  screenshotAlt: string;
  result: unknown;
}) {
  return (
    <>
      {screenshotUrl ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2">
          <img
            className="max-h-[34rem] w-full object-contain"
            src={screenshotUrl}
            alt={screenshotAlt}
          />
        </div>
      ) : null}

      {result !== null ? (
        <div className="space-y-2">
          <p className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Last command result
          </p>
          <JsonResult value={result} />
        </div>
      ) : null}
    </>
  );
}

function EventLog({ events, onClear }: { events: ConsoleEntry[]; onClear: () => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
          Live console + network events
        </p>
        <button
          className={secondaryButtonClassName}
          disabled={events.length === 0}
          type="button"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      {events.length === 0 ? (
        <p className="border border-dashed border-[color:var(--bo-border)] p-3 text-sm text-[var(--bo-muted)]">
          Connect and interact with the page to stream requests, console calls, logs, and
          exceptions.
        </p>
      ) : (
        <div className="max-h-72 overflow-auto border border-[color:var(--bo-border)] bg-[#08110f]">
          {events.map((event) => (
            <div
              key={event.id}
              className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 border-b border-[#173128] px-3 py-2 text-xs last:border-b-0"
            >
              <span className="font-mono text-[#6d9989]">{event.timestamp}</span>
              <span className="break-all text-[#a8d8c7]">{event.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CloudflareCdpInspector({
  targetId,
  targetTitle,
  webSocketDebuggerUrl,
  onClose,
}: {
  targetId: string;
  targetTitle?: string;
  webSocketDebuggerUrl: string;
  onClose: () => void;
}) {
  const connectionRef = useRef<CdpConnection | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [navigationUrl, setNavigationUrl] = useState("https://fragno.dev");
  const [events, setEvents] = useState<ConsoleEntry[]>([]);
  const nextEventIdRef = useRef(1);

  useEffect(() => {
    return () => connectionRef.current?.close();
  }, []);

  useEffect(() => {
    return () => {
      if (screenshotUrl) {
        URL.revokeObjectURL(screenshotUrl);
      }
    };
  }, [screenshotUrl]);

  const runCommand = async (name: string, command: () => Promise<unknown>) => {
    setOperation(name);
    setError(null);
    try {
      const commandResult = await command();
      setResult(commandResult);
      return commandResult;
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      return undefined;
    } finally {
      setOperation(null);
    }
  };

  const connect = async () => {
    connectionRef.current?.close();
    setConnectionStatus("connecting");
    setError(null);

    const connection = new CdpConnection(webSocketDebuggerUrl, () => {
      if (connectionRef.current !== connection) {
        return;
      }

      connectionRef.current = null;
      setConnectionStatus("disconnected");
    });
    connectionRef.current = connection;
    connection.onEvent((event) => {
      if (
        event.method !== "Network.requestWillBeSent" &&
        event.method !== "Runtime.consoleAPICalled" &&
        event.method !== "Runtime.exceptionThrown" &&
        event.method !== "Log.entryAdded"
      ) {
        return;
      }

      const eventId = nextEventIdRef.current++;
      const consoleEntry = {
        id: eventId,
        timestamp: new Date().toLocaleTimeString(),
        method: event.method,
        summary: summarizeEvent(event),
      };
      setEvents((currentEvents) => [consoleEntry, ...currentEvents].slice(0, 80));
    });

    try {
      await connection.open();
      await Promise.all([
        connection.send("Page.enable"),
        connection.send("Runtime.enable"),
        connection.send("Network.enable"),
        connection.send("Log.enable"),
        connection.send("Performance.enable"),
      ]);
      setConnectionStatus("connected");
    } catch (caughtError) {
      connection.close();
      connectionRef.current = null;
      setConnectionStatus("disconnected");
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    }
  };

  const disconnect = () => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnectionStatus("disconnected");
  };

  const send = <TResult,>(method: string, params?: Record<string, unknown>) => {
    const connection = connectionRef.current;
    if (!connection) {
      throw new Error("Connect to the target before sending CDP commands.");
    }
    return connection.send<TResult>(method, params);
  };

  const inspectOverview = () =>
    runCommand("Page overview", async () => {
      const response = await send<{ result: { value: PageOverview } }>("Runtime.evaluate", {
        expression: overviewExpression,
        returnByValue: true,
      });
      return response.result.value;
    });

  const inspectCookies = () =>
    runCommand("Cookies", async () => {
      const response = await send<{ cookies: Cookie[] }>("Storage.getCookies");
      return response.cookies;
    });

  const inspectStorage = () =>
    runCommand("Web storage", async () => {
      const response = await send<{ result: { value: StorageSnapshot } }>("Runtime.evaluate", {
        expression: storageExpression,
        returnByValue: true,
      });
      return response.result.value;
    });

  const inspectPerformance = () =>
    runCommand("Performance metrics", async () => {
      const response = await send<{ metrics: PerformanceMetric[] }>("Performance.getMetrics");
      return response.metrics.reduce<Record<string, number>>((metrics, metric) => {
        if (metric.value !== 0) {
          metrics[metric.name] = metric.value;
        }
        return metrics;
      }, {});
    });

  const inspectAccessibility = () =>
    runCommand("Accessibility tree", async () => {
      const response = await send<{ nodes: AccessibilityNode[] }>("Accessibility.getFullAXTree", {
        depth: 4,
      });
      return response.nodes.reduce<Array<{ id: string; role: string; name: string }>>(
        (nodes, node) => {
          if (!node.ignored) {
            nodes.push({
              id: node.nodeId,
              role: node.role?.value ?? "unknown",
              name: node.name?.value ?? "",
            });
          }
          return nodes;
        },
        [],
      );
    });

  const captureScreenshot = () =>
    runCommand("Screenshot", async () => {
      const response = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const binary = Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0));
      if (screenshotUrl) {
        URL.revokeObjectURL(screenshotUrl);
      }
      const nextScreenshotUrl = URL.createObjectURL(new Blob([binary], { type: "image/png" }));
      setScreenshotUrl(nextScreenshotUrl);
      return { bytes: binary.byteLength, format: "png" };
    });

  const navigate = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runCommand("Navigate", () => send("Page.navigate", { url: navigationUrl }));
  };

  const connected = connectionStatus === "connected";
  const inspectionOperations: Array<{ label: string; run: () => Promise<unknown> }> = [
    { label: "Page overview", run: inspectOverview },
    { label: "Cookies", run: inspectCookies },
    { label: "Local + session storage", run: inspectStorage },
    { label: "Performance metrics", run: inspectPerformance },
    { label: "Accessibility tree", run: inspectAccessibility },
    { label: "Capture viewport", run: captureScreenshot },
    { label: "Reload page", run: () => runCommand("Reload page", () => send("Page.reload")) },
  ];

  return (
    <FormContainer
      eyebrow="Raw Chrome DevTools Protocol"
      title={targetTitle || targetId}
      description="Connect directly to this target's short-lived signed WebSocket URL and issue CDP commands from your browser."
    >
      <div className="flex flex-wrap items-center gap-2">
        <BackofficeStatusLight tone={connected ? "live" : "waiting"}>
          {connectionStatus}
        </BackofficeStatusLight>
        <code className="min-w-0 flex-1 text-xs break-all text-[var(--bo-muted)]">{targetId}</code>
        {connected ? (
          <button className={secondaryButtonClassName} type="button" onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <button
            className={primaryButtonClassName}
            disabled={connectionStatus === "connecting"}
            type="button"
            onClick={() => void connect()}
          >
            {connectionStatus === "connecting" ? "Connecting…" : "Connect WebSocket"}
          </button>
        )}
        <button className={secondaryButtonClassName} type="button" onClick={onClose}>
          Hide inspector
        </button>
      </div>

      {error ? (
        <p className="border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
          {error}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-3 md:flex-row md:items-end"
        onSubmit={(event) => void navigate(event)}
      >
        <div className="min-w-0 flex-1">
          <FormField
            label="Navigate target"
            hint="Runs Page.navigate through the active connection."
          >
            <input
              className={controlClassName}
              value={navigationUrl}
              inputMode="url"
              onChange={(event) => {
                setNavigationUrl(event.target.value);
              }}
            />
          </FormField>
        </div>
        <button
          className={primaryButtonClassName}
          disabled={!connected || operation !== null}
          type="submit"
        >
          Navigate
        </button>
      </form>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {inspectionOperations.map(({ label, run }) => (
          <button
            key={label}
            className={secondaryButtonClassName}
            disabled={!connected || operation !== null}
            type="button"
            onClick={() => void run()}
          >
            {operation === label ? `${label}…` : label}
          </button>
        ))}
      </div>

      <CommandOutput
        screenshotUrl={screenshotUrl}
        screenshotAlt={`Remote browser screenshot of ${targetTitle || targetId}`}
        result={result}
      />

      <EventLog
        events={events}
        onClear={() => {
          setEvents([]);
        }}
      />
    </FormContainer>
  );
}
