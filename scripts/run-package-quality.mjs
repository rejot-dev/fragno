import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runAtRoot = process.argv.includes("--root");
const task = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const workspacePath = relative(repositoryRoot, process.cwd()).split(sep).join("/");
const workspaceRoots = [
  "apps",
  "example-apps",
  "example-fragments",
  "packages",
  "packages-private",
];

if (!task) {
  console.error("Usage: run-package-quality.mjs <task> [--root]");
  process.exit(1);
}

if (!runAtRoot && (!workspacePath || workspacePath.startsWith(".."))) {
  console.error("Package quality tasks must run from a workspace package.");
  process.exit(1);
}

const rootExcludePatterns = workspaceRoots.flatMap((workspaceRoot) => [
  "--ignore-pattern",
  `${workspaceRoot}/**`,
]);
const rootFormatExclusions = workspaceRoots.map((workspaceRoot) => `!${workspaceRoot}/**`);
const taskWorkingDirectory = runAtRoot ? repositoryRoot : process.cwd();
const localGitignore = resolve(taskWorkingDirectory, ".gitignore");
const ignorePaths = [
  resolve(repositoryRoot, ".gitignore"),
  resolve(repositoryRoot, ".prettierignore"),
  ...(!runAtRoot && existsSync(localGitignore) ? [localGitignore] : []),
];
const targetPaths = runAtRoot ? [".", ...rootFormatExclusions] : ["."];
const prettierPatterns = runAtRoot
  ? ["**/*.{astro,svelte,sql}", ...rootFormatExclusions]
  : ["**/*.{astro,svelte,sql}"];

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: taskWorkingDirectory,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
};

const runPnpmExec = (args) =>
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", ...args]);

const runLint = (fix = false) =>
  runPnpmExec([
    "oxlint",
    "--config",
    resolve(repositoryRoot, ".oxlintrc.json"),
    "--no-error-on-unmatched-pattern",
    "--type-aware",
    ...(fix ? ["--fix"] : []),
    ...(runAtRoot ? rootExcludePatterns : []),
    ".",
  ]);

const runFormat = (check) => {
  const formatExitCode = runPnpmExec([
    "oxfmt",
    "--config",
    resolve(repositoryRoot, ".oxfmtrc.json"),
    ...ignorePaths.flatMap((ignorePath) => ["--ignore-path", ignorePath]),
    ...(check ? ["--check"] : []),
    ...targetPaths,
  ]);
  if (formatExitCode !== 0) {
    return formatExitCode;
  }

  return runPnpmExec([
    "prettier",
    "--config",
    resolve(repositoryRoot, "prettier.unsupported.config.mjs"),
    ...ignorePaths.flatMap((ignorePath) => ["--ignore-path", ignorePath]),
    "--ignore-unknown",
    "--no-error-on-unmatched-pattern",
    ...(check ? ["--check"] : ["--write"]),
    ...prettierPatterns,
  ]);
};

const taskRunners = {
  format: () => runFormat(false),
  "format:check": () => runFormat(true),
  lint: () => runLint(),
  "lint:fix": () => runLint(true),
};

const runTask = taskRunners[task];
if (!runTask) {
  console.error(`Unknown package quality task: ${task}`);
  process.exit(1);
}

process.exit(runTask());
