export type OutboxBenchmarkConfig = {
  mode: "poll" | "stream";
  profile: boolean;
  entryCount: number;
  payloadBytes: number;
  consumerDelayMs: number;
};

const DEFAULT_ENTRY_COUNT = 1_000;
const DEFAULT_PAYLOAD_KIB = 128;
const DEFAULT_CONSUMER_DELAY_MS = 5;

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
  let profile = false;
  let entryCount = DEFAULT_ENTRY_COUNT;
  let payloadKiB = DEFAULT_PAYLOAD_KIB;
  let consumerDelayMs = DEFAULT_CONSUMER_DELAY_MS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--stream") {
      mode = "stream";
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
    if (argument === "--payload-kib") {
      payloadKiB = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    if (argument === "--consumer-delay-ms") {
      consumerDelayMs = parsePositiveInteger(argument, args[++index]);
      continue;
    }
    throw new Error(`Unknown outbox benchmark argument: ${argument}`);
  }

  return {
    mode,
    profile,
    entryCount,
    payloadBytes: payloadKiB * 1_024,
    consumerDelayMs,
  };
}
