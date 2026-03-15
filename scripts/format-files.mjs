import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const staged = args.includes("--staged");
const changed = args.includes("--changed");
const fileArgs = args.filter((arg) => !arg.startsWith("--"));

if ([staged, changed].filter(Boolean).length > 1) {
  console.error("Use only one of --staged or --changed.");
  process.exit(1);
}

const unique = (items) => [...new Set(items)];

const formatCommand = (command, commandArgs) =>
  [command, ...commandArgs]
    .map((arg) => (/[\s"'\\]/u.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");

const run = (command, commandArgs) => {
  console.log(`> ${formatCommand(command, commandArgs)}`);

  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
  });

  return result.status ?? 1;
};

const gitFiles = (...commandArgs) => {
  const result = spawnSync("git", commandArgs, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\0")
    .map((file) => file.trim())
    .filter(Boolean);
};

const changedFiles = () => {
  const untrackedFiles = gitFiles("ls-files", "--others", "--exclude-standard", "-z");
  const diffedFiles = gitFiles("diff", "--name-only", "--diff-filter=d", "HEAD", "-z");

  return unique([...untrackedFiles, ...diffedFiles]);
};

const candidateFiles = fileArgs.length
  ? fileArgs
  : staged
    ? gitFiles("diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z")
    : changed
      ? changedFiles()
      : [];

const files = unique(candidateFiles).filter((file) => {
  if (!existsSync(file)) {
    return false;
  }

  return !lstatSync(file).isSymbolicLink();
});

if (files.length === 0) {
  process.exit(0);
}

const unsupportedFiles = [];
const supportedFiles = [];

for (const file of files) {
  if (/\.(astro|sql|svelte)$/iu.test(file)) {
    unsupportedFiles.push(file);
  } else {
    supportedFiles.push(file);
  }
}

const exitCodes = [];

if (supportedFiles.length > 0) {
  exitCodes.push(run("pnpm", ["exec", "oxfmt", ...(check ? ["--check"] : []), ...supportedFiles]));
}

if (unsupportedFiles.length > 0) {
  exitCodes.push(
    run("pnpm", [
      "exec",
      "prettier",
      "--config",
      "prettier.unsupported.config.mjs",
      "--ignore-unknown",
      ...(check ? ["--check"] : ["--write"]),
      ...unsupportedFiles,
    ]),
  );
}

process.exit(exitCodes.some((code) => code !== 0) ? 1 : 0);
