export type OutboxBenchmarkConfig = {
  mode: "poll" | "stream";
  scenario: "backlog" | "live";
  profile: boolean;
  entryCount: number;
  historyEntryCount: number;
  payloadBytes: number;
  consumerDelayMs: number;
  clientCount: number;
  laggingClientCount: number;
};

const DEFAULT_ENTRY_COUNT = 1_000;
const DEFAULT_PAYLOAD_KIB = 128;
const DEFAULT_CONSUMER_DELAY_MS = 5;
const DEFAULT_CLIENT_COUNT = 1;
const DEFAULT_LAGGING_CLIENT_COUNT = 1;
const DEFAULT_HISTORY_ENTRY_COUNT = 100;

function parsePositiveInteger(flag: string, value: string | undefined): number {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

/** Parse the deterministic outbox-only benchmark workload from CLI arguments. */
export function parseOutboxBenchmarkArguments(args: string[]): OutboxBenchmarkConfig {
  let mode: OutboxBenchmarkConfig["mode"] = "poll";
  let scenario: OutboxBenchmarkConfig["scenario"] = "backlog";
  let profile = false;
  let entryCount = DEFAULT_ENTRY_COUNT;
  let historyEntryCount = DEFAULT_HISTORY_ENTRY_COUNT;
  let payloadKiB = DEFAULT_PAYLOAD_KIB;
  let consumerDelayMs = DEFAULT_CONSUMER_DELAY_MS;
  let clientCount = DEFAULT_CLIENT_COUNT;
  let laggingClientCount = DEFAULT_LAGGING_CLIENT_COUNT;
  let laggingClientCountWasProvided = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--stream") {
      mode = "stream";
      continue;
    }
    if (argument === "--live") {
      scenario = "live";
      continue;
    }
    if (argument === "--profile") {
      profile = true;
      continue;
    }
    if (argument === "--entries") {
      entryCount = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--history-entries") {
      historyEntryCount = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--payload-kib") {
      payloadKiB = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--consumer-delay-ms") {
      consumerDelayMs = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--clients") {
      clientCount = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--lagging-clients") {
      laggingClientCount = parsePositiveInteger(argument, args[++index]);
      laggingClientCountWasProvided = true;
      continue;
    }
    throw new Error(`Unknown outbox benchmark argument: ${argument}`);
  }

  if (scenario === "live" && mode !== "stream") {
    throw new Error("--live requires --stream.");
  }
  if (scenario !== "live" && laggingClientCountWasProvided) {
    throw new Error("--lagging-clients requires --live.");
  }
  if (scenario === "live" && laggingClientCount > historyEntryCount) {
    throw new Error("--lagging-clients cannot exceed --history-entries.");
  }

  return {
    mode,
    scenario,
    profile,
    entryCount,
    historyEntryCount,
    payloadBytes: payloadKiB * 1_024,
    consumerDelayMs,
    clientCount,
    laggingClientCount,
  };
}
