#!/usr/bin/env node
import { run } from "../dist/cli/cli.js";

const exitCode = await run(process.argv);
if (typeof exitCode === "number") {
  process.exitCode = exitCode;
}
