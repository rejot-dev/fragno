const maxFrameBytes = 8 * 1024 * 1024;

/** Hard bounds apply independently on both peers, including before the guest starts. */
export const CODEMODE_LIMITS = {
  maxFrameBytes,
  // Leave room for the RPC envelope and the host's bounded provider capability table.
  maxRpcPayloadBytes: maxFrameBytes - 64 * 1024,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxSessionBytes: 64 * 1024 * 1024,
  // Counts an activation's code together with its source modules.
  maxSourceBytes: 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxDepth: 64,
  maxEntries: 10_000,
  maxRpcReferences: 1024,
  maxLogs: 20_000,
  // Logs and a modest result fit one saved file in Backoffice's database upload storage (1.9 MB).
  maxLogBytes: 1.5 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  startTimeoutMs: 10_000,
  compileTimeoutMs: 60_000,
  activationTimeoutMs: 125_000,
  hostDrainTimeoutMs: 5_000,
  // Bounds one compiling isolate's memory; compilations beyond it wait their turn. Not yet measured:
  // tune it from out-of-memory restarts under concurrent dependency-heavy builds.
  maxBridgeCompilations: 8,
  // Compilations beyond this many waiters are turned away at once; each waiter polls on a timer.
  maxQueuedBridgeCompilations: 32,
  cpuMs: 5_000,
  subRequests: 1_000,
} as const;
