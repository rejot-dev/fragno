import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";

const bytesPerMegabyte = 1024 * 1024;
const childResultPrefix = "BACKOFFICE_WORKER_HEAP_PROFILE=";
const scriptPath = fileURLToPath(import.meta.url);
const backofficeDirectory = path.resolve(path.dirname(scriptPath), "..");
const workerBundles = {
  objects: {
    label: "object host",
    sourceDirectory: path.join(backofficeDirectory, "dist/rejot_backoffice"),
  },
  web: {
    label: "web worker",
    sourceDirectory: path.join(backofficeDirectory, "build/server"),
  },
};

if (nodeProcess.argv[2] === "--probe-child") {
  await runProbeChild(nodeProcess.argv[3]);
} else {
  runProfiler(parseProfilerArguments(nodeProcess.argv.slice(2)));
}

function parseProfilerArguments(argumentsToParse) {
  let worker = "all";
  let runs = 3;
  let jsonPath = null;

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--worker") {
      worker = argumentsToParse[index + 1];
      index += 1;
    } else if (argument === "--runs") {
      runs = Number(argumentsToParse[index + 1]);
      index += 1;
    } else if (argument === "--json") {
      jsonPath = path.resolve(argumentsToParse[index + 1]);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      printUsage();
      nodeProcess.exit(0);
    } else {
      throw new Error(`Unknown worker heap profiler argument: ${argument}`);
    }
  }

  if (worker !== "all" && !Object.hasOwn(workerBundles, worker)) {
    throw new Error(`--worker must be one of: all, ${Object.keys(workerBundles).join(", ")}`);
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }

  return { worker, runs, jsonPath };
}

function printUsage() {
  console.log(`Usage: node scripts/profile-worker-heap.mjs [options]

Options:
  --worker <all|objects|web>  Production Worker bundle to profile (default: all)
  --runs <count>              Fresh Node processes used for median values (default: 3)
  --json <path>               Write the complete aggregated report as JSON
  --help                      Show this help`);
}

function runProfiler(options) {
  const selectedWorkers = options.worker === "all" ? Object.keys(workerBundles) : [options.worker];
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "backoffice-worker-heap-"));
  const reports = [];

  try {
    for (const workerName of selectedWorkers) {
      const worker = workerBundles[workerName];
      assertProductionBundleExists(worker.sourceDirectory);

      const instrumentedDirectory = path.join(temporaryRoot, workerName);
      const instrumentation = instrumentProductionBundle(
        worker.sourceDirectory,
        instrumentedDirectory,
      );
      const runs = Array.from({ length: options.runs }, () =>
        executeProbeChild(instrumentedDirectory),
      );
      const report = aggregateProbeRuns(workerName, worker.label, instrumentation, runs);
      reports.push(report);
      printReport(report);
    }

    if (options.jsonPath) {
      mkdirSync(path.dirname(options.jsonPath), { recursive: true });
      writeFileSync(
        options.jsonPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`,
      );
      console.log(`\nWrote ${path.relative(nodeProcess.cwd(), options.jsonPath)}`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertProductionBundleExists(sourceDirectory) {
  if (!statSync(sourceDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Production bundle not found at ${path.relative(backofficeDirectory, sourceDirectory)}. Run the Backoffice build first.`,
    );
  }
  if (!statSync(path.join(sourceDirectory, "index.js"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Production bundle has no index.js: ${sourceDirectory}`);
  }
}

function instrumentProductionBundle(sourceDirectory, outputDirectory) {
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  cpSync(sourceDirectory, outputDirectory, { recursive: true });

  const javascriptFiles = listFiles(outputDirectory).filter((file) => file.endsWith(".js"));
  let nextProbeId = 0;
  let regionCount = 0;
  let commonJsHelperCount = 0;
  let commonJsCallCount = 0;

  for (const file of javascriptFiles) {
    const bundleModuleName = path.relative(outputDirectory, file);
    const sourceLines = readFileSync(file, "utf8").split("\n");
    const outputLines = [];
    const regionStack = [];

    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
      const line = sourceLines[lineIndex];
      if (line.startsWith("//#region ")) {
        const moduleName = line.slice("//#region ".length);
        const probeId = nextProbeId;
        nextProbeId += 1;
        regionCount += 1;
        regionStack.push({ moduleName, probeId });
        outputLines.push(
          line,
          `const __moduleHeapProbeFrame${probeId} = globalThis.__moduleHeapProbe?.begin(${JSON.stringify(moduleName)}, "top-level");`,
        );
        continue;
      }

      if (line.startsWith("//#endregion")) {
        const region = regionStack.pop();
        if (!region) {
          throw new Error(`Unmatched //#endregion in ${bundleModuleName}:${lineIndex + 1}`);
        }
        outputLines.push(
          `globalThis.__moduleHeapProbe?.end(__moduleHeapProbeFrame${region.probeId});`,
          line,
        );
        continue;
      }

      if (
        line.includes(
          "var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);",
        )
      ) {
        commonJsHelperCount += 1;
        outputLines.push(`var __commonJSMin = (moduleName, cb, mod) => () => {
\tif (mod) return mod.exports;
\tconst frame = globalThis.__moduleHeapProbe?.begin(moduleName, "lazy-commonjs");
\ttry {
\t\tcb((mod = { exports: {} }).exports, mod);
\t\tcb = null;
\t\treturn mod.exports;
\t} finally {
\t\tglobalThis.__moduleHeapProbe?.end(frame);
\t}
};`);
        continue;
      }

      if (line.includes("__commonJSMin(") && !line.startsWith("import ")) {
        const activeRegion = regionStack.at(-1);
        const moduleName =
          activeRegion?.moduleName ?? `${bundleModuleName}:${lineIndex + 1} (generated)`;
        const instrumentedLine = line.replaceAll(
          "__commonJSMin(",
          `__commonJSMin(${JSON.stringify(moduleName)}, `,
        );
        commonJsCallCount += countOccurrences(line, "__commonJSMin(");
        outputLines.push(instrumentedLine);
        continue;
      }

      outputLines.push(line);
    }

    if (regionStack.length > 0) {
      throw new Error(`Unclosed //#region in ${bundleModuleName}`);
    }
    writeFileSync(file, outputLines.join("\n"));
  }

  if (regionCount === 0) {
    throw new Error("No Rolldown module regions found in the production bundle");
  }
  if (commonJsCallCount > 0 && commonJsHelperCount === 0) {
    throw new Error("CommonJS modules were found but the Rolldown helper shape was not recognized");
  }

  return {
    javascriptFileCount: javascriptFiles.length,
    regionCount,
    commonJsCallCount,
  };
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? listFiles(file) : [file];
  });
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function executeProbeChild(instrumentedDirectory) {
  const result = spawnSync(
    nodeProcess.execPath,
    ["--expose-gc", scriptPath, "--probe-child", instrumentedDirectory],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Worker heap probe failed:\n${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }

  const resultLine = result.stdout
    .split(/\r?\n/)
    .findLast((line) => line.startsWith(childResultPrefix));
  if (!resultLine) {
    throw new Error(`Worker heap probe produced no result:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(resultLine.slice(childResultPrefix.length));
}

async function runProbeChild(instrumentedDirectory) {
  if (!instrumentedDirectory) {
    throw new Error("Probe child requires an instrumented bundle directory");
  }

  registerCloudflareWorkersStub();
  const records = [];
  const stack = [];
  globalThis.__moduleHeapProbe = {
    begin(moduleName, phase) {
      const frame = {
        moduleName,
        phase,
        before: v8.getHeapStatistics().used_heap_size,
        child: 0,
      };
      stack.push(frame);
      return frame;
    },
    end(frame) {
      if (!frame) {
        return;
      }
      const total = v8.getHeapStatistics().used_heap_size - frame.before;
      const completedFrame = stack.pop();
      if (completedFrame !== frame) {
        throw new Error(`Heap probe stack mismatch for ${frame.moduleName}`);
      }
      if (stack.length > 0) {
        stack.at(-1).child += total;
      }
      records.push({
        moduleName: frame.moduleName,
        phase: frame.phase,
        exclusive: total - frame.child,
        total,
      });
    },
  };

  await settleHeap();
  const heapBeforeImport = v8.getHeapStatistics().used_heap_size;
  await import(pathToFileURL(path.join(instrumentedDirectory, "index.js")).href);
  await settleHeap();
  const heapAfterImport = v8.getHeapStatistics().used_heap_size;

  if (stack.length > 0) {
    throw new Error(`Heap probe finished with ${stack.length} open module frames`);
  }

  nodeProcess.stdout.write(
    `${childResultPrefix}${JSON.stringify({
      retainedHeapDelta: heapAfterImport - heapBeforeImport,
      records,
    })}\n`,
  );
}

function registerCloudflareWorkersStub() {
  const stubSource = `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export const env = new Proxy({}, { get() { return undefined; } });
const span = { setAttribute() {}, setStatus() {}, addEvent() {}, end() {} };
export const tracing = {
  enterSpan(_name, callback) { return callback(span); },
  getActiveSpan() { return undefined; },
};
`;
  const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") {
        return { url: stubUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

async function settleHeap() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  globalThis.gc();
  globalThis.gc();
}

function aggregateProbeRuns(workerName, workerLabel, instrumentation, runs) {
  const runRecords = runs.map((run) => aggregateRunRecords(run.records));
  const recordKeys = new Set(runRecords.flatMap((records) => [...records.keys()]));
  const records = [...recordKeys].map((recordKey) => {
    const [phase, moduleName] = splitRecordKey(recordKey);
    return {
      moduleName,
      phase,
      exclusive: median(runRecords.map((records) => records.get(recordKey) ?? 0)),
    };
  });

  const packageRuns = runRecords.map(aggregateRecordsByPackage);
  const packageKeys = new Set(packageRuns.flatMap((packages) => [...packages.keys()]));
  const packages = [...packageKeys].map((packageName) => ({
    packageName,
    exclusive: median(packageRuns.map((packagesForRun) => packagesForRun.get(packageName) ?? 0)),
  }));

  return {
    worker: workerName,
    label: workerLabel,
    runs: runs.length,
    instrumentation,
    retainedHeapDelta: median(runs.map((run) => run.retainedHeapDelta)),
    records: records.sort((left, right) => right.exclusive - left.exclusive),
    packages: packages.sort((left, right) => right.exclusive - left.exclusive),
  };
}

function aggregateRunRecords(records) {
  const aggregated = new Map();
  for (const record of records) {
    const key = createRecordKey(record.phase, record.moduleName);
    aggregated.set(key, (aggregated.get(key) ?? 0) + record.exclusive);
  }
  return aggregated;
}

function createRecordKey(phase, moduleName) {
  return `${phase}\0${moduleName}`;
}

function splitRecordKey(recordKey) {
  const separatorIndex = recordKey.indexOf("\0");
  return [recordKey.slice(0, separatorIndex), recordKey.slice(separatorIndex + 1)];
}

function aggregateRecordsByPackage(records) {
  const packages = new Map();
  for (const [recordKey, exclusive] of records) {
    const [, moduleName] = splitRecordKey(recordKey);
    const packageName = classifyModule(moduleName);
    packages.set(packageName, (packages.get(packageName) ?? 0) + exclusive);
  }
  return packages;
}

function classifyModule(moduleName) {
  const npmPackageMatches = [...moduleName.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  const npmPackage = npmPackageMatches.at(-1)?.[1];
  if (npmPackage && npmPackage !== ".pnpm") {
    return `npm:${npmPackage}`;
  }

  const workspacePackage = moduleName.match(/(?:^|\.\.\/)packages\/([^/]+)/)?.[1];
  if (workspacePackage) {
    return `workspace:${workspacePackage}`;
  }

  if (/^(?:app|workers|content)\//.test(moduleName) || moduleName.includes("/apps/backoffice/")) {
    return "app:backoffice";
  }

  return "other";
}

function median(values) {
  const sortedValues = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2
    : sortedValues[midpoint];
}

function printReport(report) {
  console.log(`\n${report.label} (${report.runs} runs)`);
  console.log(
    `Instrumented ${report.instrumentation.regionCount.toLocaleString()} source regions and ${report.instrumentation.commonJsCallCount.toLocaleString()} lazy CommonJS modules across ${report.instrumentation.javascriptFileCount} generated JavaScript files.`,
  );
  console.log(
    `Median retained heap delta after module evaluation: ${formatMegabytes(report.retainedHeapDelta)} MB`,
  );

  console.log("\nLargest module initialization deltas:");
  for (const record of report.records.filter(hasReportableDelta).slice(0, 40)) {
    console.log(
      `${formatMegabytes(record.exclusive).padStart(8)} MB  ${record.phase.padEnd(13)}  ${record.moduleName}`,
    );
  }

  console.log("\nLargest package/source initialization deltas:");
  for (const packageRecord of report.packages.filter(hasReportableDelta).slice(0, 40)) {
    console.log(
      `${formatMegabytes(packageRecord.exclusive).padStart(8)} MB  ${packageRecord.packageName}`,
    );
  }
}

function hasReportableDelta(record) {
  return record.exclusive >= 128 * 1024;
}

function formatMegabytes(bytes) {
  return (bytes / bytesPerMegabyte).toFixed(2);
}
