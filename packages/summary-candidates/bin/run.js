#!/usr/bin/env node

import { runSummaryCandidatesCli } from "../dist/summary-candidates-cli.js";

try {
  await runSummaryCandidatesCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
