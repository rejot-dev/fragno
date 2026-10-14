// Runs the package's Vitest tests affected by changes since the Turbo SCM base. Import-graph
// selection only sees this package's own source files, so anything else that changed runs the full
// suite. Selection is never authoritative: `test` on main still runs every test.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = relative(repositoryRoot, process.cwd()).split(sep).join("/");
// Projects whose tests reach code outside their import graph, such as Workers loaded from the
// Wrangler entry point, always run in full.
const fullProjects = process.argv
  .slice(2)
  .filter((argument) => argument.startsWith("--full-project="))
  .map((argument) => argument.slice("--full-project=".length));
const importGraphExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
// Coverage of a partial run is meaningless and slows it down.
const vitestOptions = ["--run", "--passWithNoTests", "--coverage.enabled=false"];

function git(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function changedFiles(base) {
  const [mergeBase] = git(["merge-base", base, "HEAD"]);
  return [
    ...new Set([
      ...git(["diff", "--name-only", "--no-renames", mergeBase]),
      ...git(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
}

function workspacePaths() {
  const { name } = JSON.parse(readFileSync("package.json", "utf8"));
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "turbo",
      "query",
      `query {
        packages { items { path } }
        package(name: ${JSON.stringify(name)}) { allDependencies { items { path } } }
      }`,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`turbo query failed: ${result.stderr.trim()}`);
  }
  const { data } = JSON.parse(result.stdout);
  // The root workspace has an empty path; its files count as repository files.
  const paths = (items) => items.map((item) => item.path).filter(Boolean);
  return {
    all: paths(data.packages.items),
    dependencies: paths(data.package.allDependencies.items),
  };
}

function isInside(file, directory) {
  return file.startsWith(`${directory}/`);
}

/** Returns why the import graph cannot select tests for these changes, or null if it can. */
function fullRunReason(files) {
  const workspaces = workspacePaths();
  for (const file of files) {
    // Markdown is documentation unless the package's `forceRerunTriggers` match it.
    if (extname(file) === ".md") {
      continue;
    }
    if (isInside(file, packagePath)) {
      if (!existsSync(resolve(repositoryRoot, file))) {
        return `${file} was deleted`;
      }
      if (!importGraphExtensions.has(extname(file))) {
        return `${file} is not part of the import graph`;
      }
    } else if (workspaces.dependencies.some((directory) => isInside(file, directory))) {
      return `dependency file ${file} changed`;
    } else if (!workspaces.all.some((directory) => isInside(file, directory))) {
      return `repository file ${file} changed`;
    }
  }
  return null;
}

/** `vitest related` selects listed test files directly, so full projects share one run. */
function testFiles(project) {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "list", `--project=${project}`, "--filesOnly", "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`vitest list --project=${project} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout).map((test) => test.file);
}

function run(args) {
  const result = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function runChangedTests() {
  const base = process.env.TURBO_SCM_BASE ?? "main";
  const files = changedFiles(base);
  const reason = fullRunReason(files);
  if (reason) {
    console.log(`Running all tests: ${reason}.`);
    return run(["vitest", ...vitestOptions]);
  }

  const ownFiles = files
    .filter((file) => isInside(file, packagePath))
    .map((file) => resolve(repositoryRoot, file));
  if (ownFiles.length === 0) {
    console.log(`No changes affect this package's tests since ${base}.`);
    return 0;
  }
  console.log(`Running tests related to ${ownFiles.length} changed files since ${base}.`);
  // `forceRerunTriggers` widens this to the full suite for files the import graph cannot see.
  return run([
    "vitest",
    "related",
    ...vitestOptions,
    ...ownFiles,
    // Markdown reaches tests only through `forceRerunTriggers`, which already run every test.
    ...(ownFiles.every((file) => extname(file) === ".md")
      ? []
      : fullProjects.flatMap((project) => testFiles(project))),
  ]);
}

process.exit(runChangedTests());
