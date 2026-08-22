const FRAGNO_BROWSER_PERSISTENCE_DIAGNOSTICS_INTERVAL_MS = 3_000;
const FRAGNO_BROWSER_PERSISTENCE_INSPECTION_TIMEOUT_MS = 1_000;

type FragnoBrowserDiagnostic<TValue> =
  | { status: "available"; value: TValue }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string };

type FragnoBrowserLock = {
  name: string;
  mode: string;
  clientId: string | null;
};

type FragnoBrowserLockSnapshot = {
  held: FragnoBrowserLock[];
  pending: FragnoBrowserLock[];
  relevantHeld: FragnoBrowserLock[];
  relevantPending: FragnoBrowserLock[];
  interpretation: string;
};

type FragnoBrowserStorageEstimate = {
  quota: number | null;
  usage: number | null;
  usageDetails: Record<string, number> | null;
};

type FragnoBrowserWorkerProbeSnapshot =
  | { status: "unsupported"; reason: string }
  | { status: "starting"; elapsedMs: number }
  | {
      status: "responsive";
      responseMs: number;
      runtime: {
        timerAvailable: boolean;
        opfsAvailable: boolean;
        fileSystemFileHandleGlobalAvailable: boolean;
        syncAccessHandlePrototypeAvailable: boolean;
      };
    }
  | { status: "failed"; error: string };

type FragnoBrowserWorkerProbe = {
  snapshot(): FragnoBrowserWorkerProbeSnapshot;
  cleanup(): void;
};

type FragnoOPFSEntry =
  | { kind: "file"; name: string }
  | {
      kind: "directory";
      name: string;
      entries: Array<{ name: string; kind: string }>;
      inspectionError: string | null;
    };

type FragnoBrowserDiagnosticsGlobal = typeof globalThis & {
  FileSystemFileHandle?: {
    prototype?: { createSyncAccessHandle?: unknown };
  };
  navigator?: Navigator & {
    storage?: StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
  };
};

/** Captures worker, runtime, storage, Web Locks, and OPFS state during a stalled browser startup. */
export type FragnoBrowserPersistenceDiagnostics = {
  databaseName: string;
  elapsedMs: number;
  timerDriftMs: number;
  collectedAt: string;
  likelyCause: string;
  workerProbe: FragnoBrowserWorkerProbeSnapshot;
  runtime: {
    href: string | null;
    origin: string | null;
    userAgent: string | null;
    visibilityState: DocumentVisibilityState | null;
    readyState: DocumentReadyState | null;
    documentHasFocus: boolean | null;
    isSecureContext: boolean;
    crossOriginIsolated: boolean;
    online: boolean | null;
    hardwareConcurrency: number | null;
    workerAvailable: boolean;
    broadcastChannelAvailable: boolean;
    webLocksAvailable: boolean;
    opfsAvailable: boolean;
    fileSystemFileHandleGlobalAvailable: boolean;
  };
  webLocks: FragnoBrowserDiagnostic<FragnoBrowserLockSnapshot>;
  storageEstimate: FragnoBrowserDiagnostic<FragnoBrowserStorageEstimate>;
  persistedStorage: FragnoBrowserDiagnostic<boolean>;
  opfsEntries: FragnoBrowserDiagnostic<FragnoOPFSEntry[]>;
};

type FragnoBrowserPersistenceStartupOptions<TResource> = {
  databaseName: string;
  onDiagnostic: ((diagnostics: FragnoBrowserPersistenceDiagnostics) => void) | null;
  openPersistence(): Promise<TResource>;
};

type FragnoBrowserPersistenceDiagnosticInspectors = {
  webLocks(): Promise<FragnoBrowserDiagnostic<FragnoBrowserLockSnapshot>>;
  storageEstimate(): Promise<FragnoBrowserDiagnostic<FragnoBrowserStorageEstimate>>;
  persistedStorage(): Promise<FragnoBrowserDiagnostic<boolean>>;
  opfsEntries(): Promise<FragnoBrowserDiagnostic<FragnoOPFSEntry[]>>;
};

/** Opens browser persistence immediately while an observational worker probe reports startup diagnostics. */
export async function openFragnoBrowserPersistenceWithDiagnostics<TResource>(
  options: FragnoBrowserPersistenceStartupOptions<TResource>,
): Promise<TResource> {
  const startedAt = Date.now();
  const workerProbe = startFragnoBrowserWorkerProbe();
  const diagnosticsInspectors = createFragnoBrowserPersistenceDiagnosticInspectors(
    options.databaseName,
  );
  let settled = false;
  let expectedDiagnosticsElapsedMs = FRAGNO_BROWSER_PERSISTENCE_DIAGNOSTICS_INTERVAL_MS;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleDiagnostics() {
    diagnosticsTimer = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      void collectFragnoBrowserPersistenceDiagnostics({
        databaseName: options.databaseName,
        elapsedMs,
        timerDriftMs: Math.max(0, elapsedMs - expectedDiagnosticsElapsedMs),
        workerProbe: workerProbe.snapshot(),
        inspectors: diagnosticsInspectors,
      }).then((diagnostics) => {
        if (settled) {
          return;
        }

        console.warn(
          `Fragno outbox browser persistence is still opening after ${diagnostics.elapsedMs}ms. ${diagnostics.likelyCause} Initialization will keep waiting.`,
          diagnostics,
        );
        try {
          options.onDiagnostic?.(diagnostics);
        } catch (error) {
          console.error("Fragno browser persistence diagnostic listener failed.", error);
        }
        expectedDiagnosticsElapsedMs += FRAGNO_BROWSER_PERSISTENCE_DIAGNOSTICS_INTERVAL_MS;
        scheduleDiagnostics();
      });
    }, FRAGNO_BROWSER_PERSISTENCE_DIAGNOSTICS_INTERVAL_MS);
  }

  scheduleDiagnostics();
  try {
    return await options.openPersistence();
  } finally {
    settled = true;
    clearTimeout(diagnosticsTimer);
    workerProbe.cleanup();
  }
}

function startFragnoBrowserWorkerProbe(): FragnoBrowserWorkerProbe {
  const browserGlobal = globalThis as FragnoBrowserDiagnosticsGlobal;
  if (
    typeof browserGlobal.Worker !== "function" ||
    typeof browserGlobal.Blob !== "function" ||
    typeof browserGlobal.URL?.createObjectURL !== "function"
  ) {
    return {
      snapshot: () => ({
        status: "unsupported",
        reason: "Dedicated worker probing is unavailable in this runtime.",
      }),
      cleanup() {},
    };
  }

  const startedAt = Date.now();
  let snapshot: FragnoBrowserWorkerProbeSnapshot = { status: "starting", elapsedMs: 0 };
  let worker: Worker | null = null;
  let workerUrl: string | null = null;

  function cleanup() {
    worker?.terminate();
    worker = null;
    if (workerUrl) {
      browserGlobal.URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
  }

  try {
    const source = `globalThis.postMessage({
      type: "fragno-browser-worker-ready",
      timerAvailable: typeof globalThis.setTimeout === "function",
      opfsAvailable: typeof globalThis.navigator?.storage?.getDirectory === "function",
      fileSystemFileHandleGlobalAvailable: typeof globalThis.FileSystemFileHandle === "function",
      syncAccessHandlePrototypeAvailable:
        typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle === "function",
    });`;
    workerUrl = browserGlobal.URL.createObjectURL(
      new browserGlobal.Blob([source], { type: "text/javascript" }),
    );
    worker = new browserGlobal.Worker(workerUrl);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const runtime = event.data as {
        type: "fragno-browser-worker-ready";
        timerAvailable: boolean;
        opfsAvailable: boolean;
        fileSystemFileHandleGlobalAvailable: boolean;
        syncAccessHandlePrototypeAvailable: boolean;
      };
      snapshot = {
        status: "responsive",
        responseMs: Date.now() - startedAt,
        runtime: {
          timerAvailable: runtime.timerAvailable,
          opfsAvailable: runtime.opfsAvailable,
          fileSystemFileHandleGlobalAvailable: runtime.fileSystemFileHandleGlobalAvailable,
          syncAccessHandlePrototypeAvailable: runtime.syncAccessHandlePrototypeAvailable,
        },
      };
      cleanup();
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      snapshot = {
        status: "failed",
        error: event.message || "Dedicated worker probe failed without an error message.",
      };
      cleanup();
    });
    worker.addEventListener("messageerror", () => {
      snapshot = {
        status: "failed",
        error: "Dedicated worker probe response could not be deserialized.",
      };
      cleanup();
    });
  } catch (error) {
    snapshot = { status: "failed", error: describeFragnoBrowserDiagnosticError(error) };
    cleanup();
  }

  return {
    snapshot() {
      if (snapshot.status !== "starting") {
        return snapshot;
      }
      return { status: "starting", elapsedMs: Date.now() - startedAt };
    },
    cleanup,
  };
}

function createFragnoBrowserPersistenceDiagnosticInspectors(
  databaseName: string,
): FragnoBrowserPersistenceDiagnosticInspectors {
  return {
    webLocks: createRecurringFragnoBrowserDiagnosticInspector("Web Locks inspection", () =>
      inspectFragnoBrowserLocks(databaseName),
    ),
    storageEstimate: createRecurringFragnoBrowserDiagnosticInspector(
      "Storage estimate inspection",
      inspectFragnoBrowserStorageEstimate,
    ),
    persistedStorage: createRecurringFragnoBrowserDiagnosticInspector(
      "Persisted storage inspection",
      inspectFragnoBrowserPersistedStorage,
    ),
    opfsEntries: createRecurringFragnoBrowserDiagnosticInspector("OPFS inspection", () =>
      inspectFragnoBrowserOPFSEntries(databaseName),
    ),
  };
}

function createRecurringFragnoBrowserDiagnosticInspector<TValue>(
  inspectionName: string,
  inspect: () => Promise<FragnoBrowserDiagnostic<TValue>>,
): () => Promise<FragnoBrowserDiagnostic<TValue>> {
  let activeInspection: Promise<FragnoBrowserDiagnostic<TValue>> | null = null;

  return function inspectFragnoBrowserDiagnostic() {
    if (activeInspection === null) {
      activeInspection = inspect().finally(() => {
        activeInspection = null;
      });
    }

    return waitForFragnoBrowserDiagnosticInspection(inspectionName, activeInspection);
  };
}

function waitForFragnoBrowserDiagnosticInspection<TValue>(
  inspectionName: string,
  inspection: Promise<FragnoBrowserDiagnostic<TValue>>,
): Promise<FragnoBrowserDiagnostic<TValue>> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve({
        status: "failed",
        error: `${inspectionName} timed out after ${FRAGNO_BROWSER_PERSISTENCE_INSPECTION_TIMEOUT_MS}ms.`,
      });
    }, FRAGNO_BROWSER_PERSISTENCE_INSPECTION_TIMEOUT_MS);

    void inspection.then(
      (diagnostic) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(diagnostic);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({ status: "failed", error: describeFragnoBrowserDiagnosticError(error) });
      },
    );
  });
}

async function collectFragnoBrowserPersistenceDiagnostics(options: {
  databaseName: string;
  elapsedMs: number;
  timerDriftMs: number;
  workerProbe: FragnoBrowserWorkerProbeSnapshot;
  inspectors: FragnoBrowserPersistenceDiagnosticInspectors;
}): Promise<FragnoBrowserPersistenceDiagnostics> {
  const browserGlobal = globalThis as FragnoBrowserDiagnosticsGlobal;
  const browserNavigator = browserGlobal.navigator;
  const browserDocument = browserGlobal.document;
  const browserLocation = browserGlobal.location;

  const [webLocks, storageEstimate, persistedStorage, opfsEntries] = await Promise.all([
    options.inspectors.webLocks(),
    options.inspectors.storageEstimate(),
    options.inspectors.persistedStorage(),
    options.inspectors.opfsEntries(),
  ]);

  const visibilityState = browserDocument?.visibilityState ?? null;
  const likelyCause = diagnoseFragnoBrowserPersistenceStall({
    visibilityState,
    workerProbe: options.workerProbe,
    webLocks,
  });

  return {
    databaseName: options.databaseName,
    elapsedMs: options.elapsedMs,
    timerDriftMs: options.timerDriftMs,
    collectedAt: new Date().toISOString(),
    likelyCause,
    workerProbe: options.workerProbe,
    runtime: {
      href: browserLocation?.href ?? null,
      origin: browserLocation?.origin ?? null,
      userAgent: browserNavigator?.userAgent ?? null,
      visibilityState,
      readyState: browserDocument?.readyState ?? null,
      documentHasFocus: browserDocument?.hasFocus() ?? null,
      isSecureContext: browserGlobal.isSecureContext ?? false,
      crossOriginIsolated: browserGlobal.crossOriginIsolated ?? false,
      online: browserNavigator?.onLine ?? null,
      hardwareConcurrency: browserNavigator?.hardwareConcurrency ?? null,
      workerAvailable: typeof browserGlobal.Worker === "function",
      broadcastChannelAvailable: typeof browserGlobal.BroadcastChannel === "function",
      webLocksAvailable: typeof browserNavigator?.locks?.query === "function",
      opfsAvailable: typeof browserNavigator?.storage?.getDirectory === "function",
      fileSystemFileHandleGlobalAvailable: typeof browserGlobal.FileSystemFileHandle === "function",
    },
    webLocks,
    storageEstimate,
    persistedStorage,
    opfsEntries,
  };
}

function diagnoseFragnoBrowserPersistenceStall(options: {
  visibilityState: DocumentVisibilityState | null;
  workerProbe: FragnoBrowserWorkerProbeSnapshot;
  webLocks: Awaited<ReturnType<typeof inspectFragnoBrowserLocks>>;
}): string {
  const hasRelevantLocks =
    options.webLocks.status === "available" &&
    (options.webLocks.value.relevantHeld.length > 0 ||
      options.webLocks.value.relevantPending.length > 0);

  if (options.workerProbe.status === "starting" && !hasRelevantLocks) {
    if (options.visibilityState === "hidden") {
      return "The diagnostic worker has not responded and OPFS has created no locks. The document is hidden, which may be contributing to worker scheduling delays in this Electron runtime; the SQLite persistence worker may also be waiting to execute.";
    }
    return "The diagnostic worker has not responded and OPFS has created no locks. The SQLite persistence worker may also be waiting to execute.";
  }

  if (options.workerProbe.status === "failed") {
    return `Diagnostic worker startup failed: ${options.workerProbe.error}`;
  }

  if (options.webLocks.status === "available") {
    return options.webLocks.value.interpretation;
  }

  return "The upstream persistence API has not completed and exposes no finer-grained initialization progress.";
}

async function inspectFragnoBrowserLocks(
  databaseName: string,
): Promise<FragnoBrowserDiagnostic<FragnoBrowserLockSnapshot>> {
  try {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager?.query) {
      return { status: "unavailable", reason: "Web Locks query is unavailable." };
    }

    const snapshot = (await lockManager.query()) as {
      held: Array<{ name: string; mode: string; clientId?: string }>;
      pending: Array<{ name: string; mode: string; clientId?: string }>;
    };
    const held = snapshot.held.map(materializeFragnoBrowserLock);
    const pending = snapshot.pending.map(materializeFragnoBrowserLock);
    const databaseLockName = `ahp:/${databaseName}`;
    const isRelevantLock = (lock: FragnoBrowserLock) =>
      lock.name === databaseLockName || lock.name.startsWith(".ahp-");
    const relevantHeld = held.filter(isRelevantLock);
    const relevantPending = pending.filter(isRelevantLock);

    let interpretation = "OPFS did not expose an active initialization lock.";
    if (relevantPending.some((lock) => lock.name === databaseLockName)) {
      interpretation = "OPFS is waiting to acquire the database access-handle lock.";
    } else if (relevantHeld.some((lock) => lock.name === databaseLockName)) {
      interpretation =
        "OPFS acquired the database access-handle lock but did not finish opening SQLite.";
    } else if (relevantHeld.some((lock) => lock.name.startsWith(".ahp-"))) {
      interpretation =
        "OPFS created its temporary VFS lock but has not requested the database access-handle lock.";
    }

    return {
      status: "available",
      value: { held, pending, relevantHeld, relevantPending, interpretation },
    };
  } catch (error) {
    return { status: "failed", error: describeFragnoBrowserDiagnosticError(error) };
  }
}

async function inspectFragnoBrowserStorageEstimate(): Promise<
  FragnoBrowserDiagnostic<FragnoBrowserStorageEstimate>
> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage?.estimate) {
      return { status: "unavailable", reason: "Storage estimate is unavailable." };
    }

    const estimate = (await storage.estimate()) as StorageEstimate & {
      usageDetails?: Record<string, number>;
    };
    return {
      status: "available",
      value: {
        quota: estimate.quota ?? null,
        usage: estimate.usage ?? null,
        usageDetails: estimate.usageDetails ? { ...estimate.usageDetails } : null,
      },
    };
  } catch (error) {
    return { status: "failed", error: describeFragnoBrowserDiagnosticError(error) };
  }
}

async function inspectFragnoBrowserPersistedStorage(): Promise<FragnoBrowserDiagnostic<boolean>> {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persisted) {
      return { status: "unavailable", reason: "Persisted storage status is unavailable." };
    }

    return { status: "available", value: await storage.persisted() };
  } catch (error) {
    return { status: "failed", error: describeFragnoBrowserDiagnosticError(error) };
  }
}

async function inspectFragnoBrowserOPFSEntries(
  databaseName: string,
): Promise<FragnoBrowserDiagnostic<FragnoOPFSEntry[]>> {
  try {
    const browserNavigator = (globalThis as FragnoBrowserDiagnosticsGlobal).navigator;
    const getDirectory = browserNavigator?.storage?.getDirectory;
    if (!getDirectory) {
      return { status: "unavailable", reason: "OPFS directory inspection is unavailable." };
    }

    const root = await getDirectory.call(browserNavigator.storage);
    const entries: FragnoOPFSEntry[] = [];
    for await (const entry of iterateFragnoFileSystemDirectory(root)) {
      if (!entry.name.startsWith(".ahp-") && !entry.name.startsWith(databaseName)) {
        continue;
      }

      if (entry.kind === "file") {
        // Reading file metadata can contend with the sync access handles whose startup we are
        // diagnosing. Directory names reveal the relevant OPFS state without perturbing it.
        entries.push({ kind: "file", name: entry.name });
        continue;
      }

      try {
        const children = [];
        for await (const child of iterateFragnoFileSystemDirectory(
          entry as FileSystemDirectoryHandle,
        )) {
          children.push({ name: child.name, kind: child.kind });
        }
        entries.push({
          kind: "directory",
          name: entry.name,
          entries: children,
          inspectionError: null,
        });
      } catch (error) {
        entries.push({
          kind: "directory",
          name: entry.name,
          entries: [],
          inspectionError: describeFragnoBrowserDiagnosticError(error),
        });
      }
    }

    return { status: "available", value: entries };
  } catch (error) {
    return { status: "failed", error: describeFragnoBrowserDiagnosticError(error) };
  }
}

function iterateFragnoFileSystemDirectory(
  directory: FileSystemDirectoryHandle,
): AsyncIterable<FileSystemHandle> {
  return (
    directory as FileSystemDirectoryHandle & {
      values(): AsyncIterable<FileSystemHandle>;
    }
  ).values();
}

function materializeFragnoBrowserLock(lock: {
  name: string;
  mode: string;
  clientId?: string;
}): FragnoBrowserLock {
  return { name: lock.name, mode: lock.mode, clientId: lock.clientId ?? null };
}

function describeFragnoBrowserDiagnosticError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
