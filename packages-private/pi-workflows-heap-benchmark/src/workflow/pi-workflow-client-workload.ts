import type {
  PiWorkflowBenchmarkClientConfig,
  PiWorkflowBenchmarkClientResult,
} from "./pi-workflow-benchmark-protocol";

type PreparedPiWorkflowClientWorkload = {
  run: () => Promise<PiWorkflowBenchmarkClientResult>;
  close: () => Promise<void>;
};

type WorkflowOutboxConsumer = {
  entriesReadThrough: (versionstamp: string | null) => number;
  waitUntilVersionstamp: (versionstamp: string | null, timeoutMs: number) => Promise<void>;
  assertHealthy: () => void;
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Pi workflow client operation aborted.");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const handleTimer = () => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    };
    const handleAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      reject(abortError(signal));
    };
    const timeout = setTimeout(handleTimer, ms);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function readJsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${operation} failed with status ${response.status}.`);
  }
  return response.json();
}

function readOutboxVersionstamp(input: unknown): string {
  if (!isRecord(input) || typeof input["versionstamp"] !== "string") {
    throw new Error("Pi workflow benchmark received an invalid outbox entry.");
  }
  return input["versionstamp"];
}

function createOutboxUrl(
  config: PiWorkflowBenchmarkClientConfig,
  route: "outbox" | "outbox/stream",
  afterVersionstamp: string | null,
): URL {
  const url = new URL(`${config.piBaseUrl}/_internal/${route}`);
  if (afterVersionstamp) {
    url.searchParams.set("afterVersionstamp", afterVersionstamp);
  }
  return url;
}

function countOutboxEntriesThrough(
  versionstamps: readonly string[],
  targetVersionstamp: string | null,
): number {
  if (targetVersionstamp === null) {
    return 0;
  }
  const firstLaterEntry = versionstamps.findIndex(
    (versionstamp) => versionstamp > targetVersionstamp,
  );
  return firstLaterEntry === -1 ? versionstamps.length : firstLaterEntry;
}

async function waitForOutboxVersionstamp(
  versionstamps: readonly string[],
  startingVersionstamp: string | null,
  targetVersionstamp: string | null,
  timeoutMs: number,
  readFailure: () => Error | null,
): Promise<void> {
  if (targetVersionstamp === null) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while ((versionstamps.at(-1) ?? startingVersionstamp ?? "") < targetVersionstamp) {
    const failure = readFailure();
    if (failure) {
      throw failure;
    }
    if (Date.now() > deadline) {
      throw new Error(`Pi workflow outbox did not reach versionstamp ${targetVersionstamp}.`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function startPollingWorkflowOutbox(
  config: PiWorkflowBenchmarkClientConfig,
  startingVersionstamp: string | null,
): WorkflowOutboxConsumer {
  const abortController = new AbortController();
  let afterVersionstamp = startingVersionstamp;
  const versionstamps: string[] = [];
  let failure: Error | null = null;

  const consume = (async () => {
    while (!abortController.signal.aborted) {
      const response = await fetch(createOutboxUrl(config, "outbox", afterVersionstamp), {
        signal: abortController.signal,
      });
      const entries = await readJsonResponse(response, "Pi workflow outbox poll");
      if (!Array.isArray(entries)) {
        throw new Error("Pi workflow outbox poll returned a non-array response.");
      }
      for (const entry of entries) {
        afterVersionstamp = readOutboxVersionstamp(entry);
        versionstamps.push(afterVersionstamp);
      }
      await sleep(config.pollIntervalMs, abortController.signal);
    }
  })().catch((error: unknown) => {
    if (!abortController.signal.aborted) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    entriesReadThrough: (versionstamp) => countOutboxEntriesThrough(versionstamps, versionstamp),
    waitUntilVersionstamp: (versionstamp, timeoutMs) =>
      waitForOutboxVersionstamp(
        versionstamps,
        startingVersionstamp,
        versionstamp,
        timeoutMs,
        () => failure,
      ),
    assertHealthy: () => {
      if (failure) {
        throw failure;
      }
    },
    close: async () => {
      abortController.abort(new Error("Pi workflow outbox polling closed."));
      await consume;
    },
  };
}

function startStreamingWorkflowOutbox(
  config: PiWorkflowBenchmarkClientConfig,
  startingVersionstamp: string | null,
): WorkflowOutboxConsumer {
  const abortController = new AbortController();
  let afterVersionstamp = startingVersionstamp;
  const versionstamps: string[] = [];
  let failure: Error | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const consume = (async () => {
    while (!abortController.signal.aborted) {
      const response = await fetch(createOutboxUrl(config, "outbox/stream", afterVersionstamp), {
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Pi workflow outbox stream failed with status ${response.status}.`);
      }
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!(value instanceof Uint8Array)) {
            throw new Error("Pi workflow outbox stream returned a non-byte chunk.");
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (/\S/u.test(line)) {
              afterVersionstamp = readOutboxVersionstamp(JSON.parse(line));
              versionstamps.push(afterVersionstamp);
            }
            newlineIndex = buffer.indexOf("\n");
          }
        }
      } finally {
        activeReader = null;
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  })().catch((error: unknown) => {
    if (!abortController.signal.aborted) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    entriesReadThrough: (versionstamp) => countOutboxEntriesThrough(versionstamps, versionstamp),
    waitUntilVersionstamp: (versionstamp, timeoutMs) =>
      waitForOutboxVersionstamp(
        versionstamps,
        startingVersionstamp,
        versionstamp,
        timeoutMs,
        () => failure,
      ),
    assertHealthy: () => {
      if (failure) {
        throw failure;
      }
    },
    close: async () => {
      abortController.abort(new Error("Pi workflow outbox streaming closed."));
      await activeReader?.cancel().catch(() => {});
      await consume;
    },
  };
}

async function readCurrentOutboxVersionstamp(
  config: PiWorkflowBenchmarkClientConfig,
): Promise<string | null> {
  const description = await readJsonResponse(
    await fetch(`${config.piBaseUrl}/_internal`),
    "Pi workflow outbox description",
  );
  if (
    !isRecord(description) ||
    (description["currentVersionstamp"] !== null &&
      typeof description["currentVersionstamp"] !== "string")
  ) {
    throw new Error("Pi workflow outbox description returned an invalid versionstamp.");
  }
  return description["currentVersionstamp"];
}

async function submitPiWorkflowCommand(config: PiWorkflowBenchmarkClientConfig): Promise<string> {
  const response = await fetch(
    `${config.piBaseUrl}/workflows/${encodeURIComponent(config.workflowName)}/sessions/${encodeURIComponent(config.sessionId)}/command`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", input: { text: config.prompt } }),
    },
  );
  const command = await readJsonResponse(response, "Pi workflow command");
  if (!isRecord(command) || typeof command["commandId"] !== "string") {
    throw new Error("Pi workflow command returned an invalid command id.");
  }
  return command["commandId"];
}

async function waitForPiWorkflowCommand(
  config: PiWorkflowBenchmarkClientConfig,
  commandId: string,
): Promise<void> {
  const url = new URL(
    `${config.piBaseUrl}/workflows/${encodeURIComponent(config.workflowName)}/sessions/${encodeURIComponent(config.sessionId)}/commands/${encodeURIComponent(commandId)}/wait`,
  );
  url.searchParams.set("timeoutMs", String(config.waitTimeoutMs));
  const response = await fetch(url);
  if (response.status !== 204) {
    throw new Error(`Pi workflow command wait failed with status ${response.status}.`);
  }
}

async function readPiWorkflowStatus(
  config: PiWorkflowBenchmarkClientConfig,
): Promise<PiWorkflowBenchmarkClientResult["status"]> {
  const response = await readJsonResponse(
    await fetch(
      `${config.workflowsBaseUrl}/${encodeURIComponent(config.workflowName)}/instances/${encodeURIComponent(config.sessionId)}`,
    ),
    "Pi workflow status",
  );
  const details = isRecord(response) ? response["details"] : null;
  if (
    !isRecord(details) ||
    typeof details["status"] !== "string" ||
    typeof details["runGeneration"] !== "number" ||
    !Number.isSafeInteger(details["runGeneration"]) ||
    details["runGeneration"] <= 0
  ) {
    throw new Error("Pi workflow status returned an invalid instance state.");
  }
  return { status: details["status"], runGeneration: details["runGeneration"] };
}

/** Prepare the HTTP cursor before measurement, then run the workflow entirely over HTTP. */
export async function preparePiWorkflowClientWorkload(
  config: PiWorkflowBenchmarkClientConfig,
): Promise<PreparedPiWorkflowClientWorkload> {
  const startingVersionstamp = await readCurrentOutboxVersionstamp(config);
  let outboxConsumer: WorkflowOutboxConsumer | null = null;

  return {
    run: async () => {
      if (outboxConsumer) {
        throw new Error("Pi workflow benchmark client workload can only run once.");
      }
      outboxConsumer =
        config.mode === "stream"
          ? startStreamingWorkflowOutbox(config, startingVersionstamp)
          : startPollingWorkflowOutbox(config, startingVersionstamp);
      const commandId = await submitPiWorkflowCommand(config);
      outboxConsumer.assertHealthy();
      await waitForPiWorkflowCommand(config, commandId);
      outboxConsumer.assertHealthy();
      const status = await readPiWorkflowStatus(config);
      const endingVersionstamp = await readCurrentOutboxVersionstamp(config);
      await outboxConsumer.waitUntilVersionstamp(endingVersionstamp, 30_000);
      outboxConsumer.assertHealthy();
      return {
        outboxEntriesRead: outboxConsumer.entriesReadThrough(endingVersionstamp),
        status,
      };
    },
    close: async () => {
      await outboxConsumer?.close();
    },
  };
}
