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
    // Applied to the replica's connection before the import, e.g. `--pragma synchronous=NORMAL`.
    pragma: { type: "string", multiple: true, default: [] },
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
  node measure.ts "$(command -v google-chrome)" '${pageUrl()}' "$views" > "result-$i-$views.json"
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
for (const [index, { import: run }] of results.entries()) {
  const importMs = run.doneMs - run.openMs;
  console.log(`\nRun ${index + 1}: statements, by time spent waiting on them`);
  console.table(
    run.database.statements.map(({ statement, count, totalMs, maxMs }) => ({
      statement,
      count,
      "total ms": Math.round(totalMs),
      "% of import": Math.round((totalMs / importMs) * 100),
      "avg ms": Number((totalMs / count).toFixed(3)),
      "max ms": Math.round(maxMs),
    })),
  );
  console.log(`Run ${index + 1}: transactions by tenth of the import`);
  console.table(
    run.database.tenths.map(({ avgMs, avgCommitMs, avgStatements, avgParamKb }, tenth) => ({
      tenth: `${tenth * 10}-${(tenth + 1) * 10}%`,
      "avg ms": Number(avgMs.toFixed(2)),
      "avg commit ms": Number(avgCommitMs.toFixed(2)),
      statements: Number(avgStatements.toFixed(1)),
      "params kB": Number(avgParamKb.toFixed(1)),
    })),
  );
  console.log(`Run ${index + 1}: PRAGMAs ${JSON.stringify(run.database.pragmas)}`);
}

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
    database: {
      busyMs: number;
      transactions: number;
      statements: Array<{ statement: string; count: number; totalMs: number; maxMs: number }>;
      tenths: Array<{
        avgMs: number;
        avgCommitMs: number;
        avgStatements: number;
        avgParamKb: number;
      }>;
      pragmas: Record<string, unknown>;
      probes: {
        selectOneMedianMs: number;
        rowsPerTransaction1Ms: number;
        rowsPerTransaction200Ms: number;
      };
    };
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
    "db wait %": Math.round((run.database.busyMs / (run.doneMs - run.openMs)) * 100),
    "SELECT 1 ms": Number(run.database.probes.selectOneMedianMs.toFixed(2)),
    "200 tx ms": Math.round(run.database.probes.rowsPerTransaction1Ms),
    "1 tx ms": Math.round(run.database.probes.rowsPerTransaction200Ms),
  };
}

function pageUrl(): string {
  const url = new URL("http://localhost:5544/");
  for (const pragma of options.pragma) {
    if (!/^\w+\s*=\s*\w+$/u.test(pragma)) {
      throw new Error(`--pragma takes name=value, not ${pragma}`);
    }
    url.searchParams.append("pragma", pragma);
  }
  return url.toString();
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
