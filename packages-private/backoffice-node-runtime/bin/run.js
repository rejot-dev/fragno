#!/usr/bin/env node

import { runBackofficeNodeRuntimeCli } from "../dist/graft/graft-control-bootstrap-cli.js";

process.exitCode = await runBackofficeNodeRuntimeCli(process.argv.slice(2));
