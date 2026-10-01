#!/usr/bin/env node
import { runProjectConnectorCli } from "../dist/cli/cli.js";

process.exitCode = await runProjectConnectorCli(process.argv.slice(2));
