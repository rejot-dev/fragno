import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const backofficeDirectory = path.resolve(path.dirname(scriptPath), "..");
const wranglerExecutable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
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

runProfiler(parseProfilerArguments(nodeProcess.argv.slice(2)));

function parseProfilerArguments(argumentsToParse) {
  let worker = "all";
  let runs = 5;
  let profileDirectory = null;

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
    } else if (argument === "--profile-dir") {
      profileDirectory = path.resolve(argumentsToParse[index + 1]);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      printUsage();
      nodeProcess.exit(0);
    } else {
      throw new Error(`Unknown worker startup profiler argument: ${argument}`);
    }
  }

  if (worker !== "all" && !Object.hasOwn(workerBundles, worker)) {
    throw new Error(`--worker must be one of: all, ${Object.keys(workerBundles).join(", ")}`);
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }

  return { worker, runs, profileDirectory };
}

function printUsage() {
  console.log(`Usage: node scripts/profile-worker-startup.mjs [options]

Options:
  --worker <all|objects|web>  Production Worker bundle to profile (default: all)
  --runs <count>              Startup profiles used for the median (default: 5)
  --profile-dir <path>        Keep each run's .cpuprofile in this directory
  --help                      Show this help`);
}

function runProfiler(options) {
  const selectedWorkers = options.worker === "all" ? Object.keys(workerBundles) : [options.worker];
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "backoffice-worker-startup-"));
  if (options.profileDirectory) {
    mkdirSync(options.profileDirectory, { recursive: true });
  }

  try {
    for (const workerName of selectedWorkers) {
      const worker = workerBundles[workerName];
      assertProductionBundleExists(worker.sourceDirectory);

      const uploadBundle = path.join(temporaryRoot, `${workerName}.bundle`);
      const upload = writeUploadBundle(worker.sourceDirectory, uploadBundle);
      const activeMilliseconds = Array.from({ length: options.runs }, (_, run) =>
        profileStartup(
          uploadBundle,
          path.join(
            options.profileDirectory ?? temporaryRoot,
            `${workerName}-startup-${run + 1}.cpuprofile`,
          ),
        ),
      );
      printReport(worker.label, upload, activeMilliseconds);
    }
    if (options.profileDirectory) {
      console.log(
        `\nWrote CPU profiles to ${path.relative(nodeProcess.cwd(), options.profileDirectory)}`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertProductionBundleExists(sourceDirectory) {
  if (!statSync(path.join(sourceDirectory, "wrangler.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Production bundle not found at ${path.relative(backofficeDirectory, sourceDirectory)}. Run the Backoffice build first.`,
    );
  }
}

// `wrangler check startup --config <dir>/wrangler.json` ignores `--config` and follows the Vite
// plugin's `.wrangler/deploy/config.json` redirect, so it always profiles the web Worker. A dry-run
// deploy of the generated config writes that Worker's exact upload for `--worker` instead.
function writeUploadBundle(sourceDirectory, uploadBundle) {
  const output = runWrangler([
    "deploy",
    "--dry-run",
    "--config",
    path.join(sourceDirectory, "wrangler.json"),
    "--outfile",
    uploadBundle,
  ]);
  return /Total Upload: ([^\n]+)/.exec(output)?.[1].trim() ?? "unknown size";
}

function profileStartup(uploadBundle, profilePath) {
  const output = runWrangler([
    "check",
    "startup",
    "--worker",
    uploadBundle,
    "--outfile",
    profilePath,
  ]);
  const active = /Active: ([\d.]+) ms/.exec(output)?.[1];
  if (!active) {
    throw new Error(`Wrangler startup check reported no active time:\n${output}`);
  }
  return Number(active);
}

function runWrangler(wranglerArguments) {
  const result = spawnSync(wranglerExecutable, wranglerArguments, {
    cwd: backofficeDirectory,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(`wrangler ${wranglerArguments.join(" ")} failed:\n${output}`);
  }
  return output;
}

function printReport(label, upload, activeMilliseconds) {
  const sorted = [...activeMilliseconds].sort((left, right) => left - right);
  console.log(`\n${label}`);
  console.log(`  upload: ${upload}`);
  console.log(
    `  local startup CPU: median ${median(sorted).toFixed(1)} ms, min ${sorted[0].toFixed(1)} ms, max ${sorted.at(-1).toFixed(1)} ms (${sorted.length} runs)`,
  );
}

function median(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
    : sortedValues[middle];
}
