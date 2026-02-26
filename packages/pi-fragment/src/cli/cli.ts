#!/usr/bin/env node

import { run } from "./mod";

const exitCode = await run(process.argv);
if (typeof exitCode === "number") {
  process.exitCode = exitCode;
}
