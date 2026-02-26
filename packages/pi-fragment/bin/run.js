#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, "..", "dist", "cli", "cli.js");
const srcCli = path.join(__dirname, "..", "src", "cli", "cli.ts");

const runBuiltCli = async () => {
  await import(pathToFileURL(distCli).href);
};

const runSourceCli = async () => {
  const require = createRequire(import.meta.url);
  let tsxCli;

  try {
    tsxCli = require.resolve("tsx/cli");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("fragno-pi: unable to find tsx to run from source.");
    console.error("Install dependencies or build the CLI before running.");
    if (message) {
      console.error(message);
    }
    process.exit(1);
    return;
  }

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, srcCli, ...process.argv.slice(2)], {
      stdio: "inherit",
    });

    child.on("error", (err) => {
      console.error(`fragno-pi: failed to start tsx (${err.message})`);
      process.exit(1);
      resolve(null);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
      resolve(null);
    });
  });
};

const main = async () => {
  if (existsSync(distCli)) {
    await runBuiltCli();
    return;
  }

  await runSourceCli();
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("fragno-pi: unexpected error while running CLI.");
  if (message) {
    console.error(message);
  }
  process.exit(1);
});
