// Builds the benchmark, runs imports on a boxd machine in headless Chrome, and downloads the results:
// `node run-remote.ts --machine dev1 --fixture outbox.jsonl [--runs no-views,views]`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    machine: { type: "string" },
    fixture: { type: "string" },
    runs: { type: "string", default: "views" },
  },
});
if (!options.machine || !options.fixture) {
  throw new Error(
    "Usage: node run-remote.ts --machine <boxd machine> --fixture <outbox.jsonl> [--runs no-views,views]",
  );
}
const machine = options.machine;
const fixture = options.fixture;
const runs = options.runs.split(",");
if (runs.some((run) => run !== "views" && run !== "no-views")) {
  throw new Error(`--runs lists "views" or "no-views" runs, not ${options.runs}`);
}

const PACKAGE_DIRECTORY = import.meta.dirname;
const REMOTE_DIRECTORY = "/home/boxd/lofi-sqlite-benchmark";
// What `serve.ts` and `measure.ts` need; `serve.ts` imports the others.
const SERVER_FILES = [
  "serve.ts",
  "outbox-fixture-server.ts",
  "measure.ts",
  "src/outbox-fixture.ts",
];

step("Building");
run("pnpm", [
  "exec",
  "turbo",
  "build",
  "--filter=@fragno-private/lofi-sqlite-import-benchmark",
  "--output-logs=errors-only",
]);

step(`Uploading the build to ${machine}:${REMOTE_DIRECTORY}`);
remote(`mkdir -p src && rm -rf dist result-*.json && echo '{"type":"module"}' > package.json`);
for (const file of SERVER_FILES) {
  boxd(["machine", "cp", join(PACKAGE_DIRECTORY, file), `${machine}:${REMOTE_DIRECTORY}/${file}`]);
}
boxd(["machine", "cp", "-r", join(PACKAGE_DIRECTORY, "dist"), `${machine}:${REMOTE_DIRECTORY}/`]);
// The upload carries macOS metadata files along.
remote(`find dist -name '._*' -delete && test -f dist/index.html`);

const fixtureHash = await sha256(fixture);
if (remote("sha256sum outbox.jsonl 2>/dev/null | cut -d' ' -f1", "capture") === fixtureHash) {
  step("The fixture on the machine is up to date");
} else {
  step("Uploading the fixture");
  boxd(["machine", "cp", fixture, `${machine}:${REMOTE_DIRECTORY}/outbox.jsonl`]);
}

step("Checking for Chrome");
remote(`command -v google-chrome > /dev/null || {
  curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb &&
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/google-chrome.deb > /dev/null; }
google-chrome --version`);

step(`Running ${runs.join(", ")}`);
remote(`node serve.ts dist outbox.jsonl 5544 > serve.log 2>&1 &
server=$!
trap 'kill $server' EXIT
until curl -sf http://localhost:5544/fixture/_internal > /dev/null; do sleep 0.2; done
i=0
for views in ${runs.join(" ")}; do
  i=$((i + 1))
  echo "Run $i: $views" >&2
  node measure.ts "$(command -v google-chrome)" 'http://localhost:5544/' "$views" > "result-$i-$views.json"
done`);

const resultsDirectory = join(
  PACKAGE_DIRECTORY,
  "results",
  new Date().toISOString().replaceAll(":", "-").slice(0, 19),
);
step(`Downloading the results to ${resultsDirectory}`);
await mkdir(resultsDirectory, { recursive: true });
const results: Results[] = [];
for (const [index, views] of runs.entries()) {
  const file = `result-${index + 1}-${views}.json`;
  boxd(["machine", "cp", `${machine}:${REMOTE_DIRECTORY}/${file}`, join(resultsDirectory, file)]);
  results.push(JSON.parse(await readFile(join(resultsDirectory, file), "utf8")) as Results);
}
console.table(results.map(summarize));
/** The parts of the page's results JSON the summary reads. */
type Results = {
  browser: string;
  fixture: { entries: number };
  import: {
    views: boolean;
    openMs: number;
    doneMs: number;
    samples: Array<{ ms: number; applied: number; readMs: number }>;
    tableCounts: Array<{ table: string; rows: number }>;
    storageUsageBytes: number;
  };
};

function summarize({ browser, fixture: { entries }, import: run }: Results) {
  // Entries per second between the samples where the import passed two fractions of the fixture.
  // The last sample saw every entry, so both samples exist.
  const rate = (from: number, to: number) => {
    const start = run.samples.find(({ applied }) => applied >= from * entries)!;
    const end = run.samples.find(({ applied }) => applied >= to * entries)!;
    return Math.round((end.applied - start.applied) / ((end.ms - start.ms) / 1000));
  };
  return {
    browser,
    views: run.views,
    "open ms": Math.round(run.openMs),
    "done s": Number((run.doneMs / 1000).toFixed(1)),
    "entries/s": Math.round(entries / ((run.doneMs - run.openMs) / 1000)),
    "0-50%/s": rate(0, 0.5),
    "50-90%/s": rate(0.5, 0.9),
    "90-100%/s": rate(0.9, 1),
    "max read ms": Math.round(Math.max(...run.samples.map(({ readMs }) => readMs))),
    "storage MB": Math.round(run.storageUsageBytes / 1e6),
  };
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

/** Runs a shell script in `REMOTE_DIRECTORY` on the machine, streaming its output or capturing it. */
function remote(script: string, output?: "capture"): string {
  return boxd(["machine", "exec", machine, "--", "sh", "-s"], {
    input: `set -e\nmkdir -p ${REMOTE_DIRECTORY} && cd ${REMOTE_DIRECTORY}\n${script}\n`,
    output,
  });
}

function boxd(args: string[], { input, output }: { input?: string; output?: "capture" } = {}) {
  return run("boxd", args, { input, output });
}

function run(
  command: string,
  args: string[],
  { input, output }: { input?: string; output?: "capture" } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_DIRECTORY,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", output ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
  return output ? result.stdout.trim() : "";
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => {
        hash.update(chunk);
      })
      .on("end", () => {
        resolve(hash.digest("hex"));
      })
      .on("error", reject);
  });
}
