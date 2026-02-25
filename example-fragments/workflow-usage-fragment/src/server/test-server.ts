#!/usr/bin/env node

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { toNodeHandler } from "@fragno-dev/node";

import type { WorkflowUsageAgentDefinition } from "../fragment/dsl";
import { initFragment } from "./init-fragment";

const DEFAULT_PORT = 4100;
const DEFAULT_HOST = "127.0.0.1";

const testAgents: Record<string, WorkflowUsageAgentDefinition> = {
  default: {
    label: "Default Agent",
    systemPrompt: "You are a helpful agent in a usage demo.",
    dsl: {
      steps: [
        { type: "wait", duration: "250ms", label: "thinking" },
        { type: "calc", expression: "2 + 2", assign: "sum" },
        { type: "random", min: 1, max: 10, round: "round", assign: "roll" },
      ],
    },
  },
  calculator: {
    label: "Calculator Agent",
    systemPrompt: "You summarize arithmetic operations.",
    dsl: {
      steps: [
        { type: "calc", expression: "(5 + 3) * 4", assign: "product" },
        { type: "wait", duration: "250ms", label: "after-product" },
        { type: "calc", expression: "42 / 7", assign: "quotient" },
        { type: "wait", duration: "250ms" },
        { type: "calc", expression: "100 - 23", assign: "difference" },
        { type: "random", min: 1, max: 20, round: "round", assign: "roll" },
        { type: "calc", expression: "17 * 3", assign: "triple" },
      ],
    },
  },
  interactive: {
    label: "Interactive Agent",
    systemPrompt: "Uses event payload values in calculations.",
    dsl: {
      steps: [
        { type: "wait", duration: "250ms", label: "warmup" },
        { type: "random", min: 1, max: 100, round: "round", assign: "seed" },
        { type: "input", key: "x", assign: "x" },
        { type: "calc", expression: "$x * 2", assign: "doubled" },
        { type: "calc", expression: "$x + $doubled", assign: "total" },
      ],
    },
  },
};

export type UsageTestServerOptions = {
  port?: number;
  host?: string;
  databasePath?: string;
};

export async function startUsageTestServer(options: UsageTestServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const {
    fragment,
    workflowsFragment,
    close: closeFragment,
  } = await initFragment({
    agents: testAgents,
    databasePath: options.databasePath,
  });

  const durableHooksDispatcher = createDurableHooksProcessor([workflowsFragment, fragment], {
    pollIntervalMs: 250,
  });
  durableHooksDispatcher.startPolling();

  const handler = toNodeHandler(fragment.handler.bind(fragment));
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${address.address}:${address.port}`.replace("::", "127.0.0.1");

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    durableHooksDispatcher.stopPolling();
    await closeFragment();
  };

  return {
    server,
    baseUrl,
    mountRoute: fragment.mountRoute,
    close,
  };
}

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseArg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return undefined;
  }
  return process.argv[index + 1];
};

const printHelp = () => {
  console.log("Usage fragment test server");
  console.log("");
  console.log("USAGE:");
  console.log("  usage-test-server [--port 4100] [--host 127.0.0.1]");
  console.log("");
  console.log("OPTIONS:");
  console.log("  --port            Port to listen on (default: 4100)");
  console.log("  --host            Host to bind (default: 127.0.0.1)");
  console.log("  --db-path         SQLite database path (default: ./usage-fragment.sqlite)");
  console.log("");
  console.log("AGENTS:");
  for (const name of Object.keys(testAgents)) {
    console.log(`  ${name}`);
  }
};

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
  } else {
    const port =
      parseNumber(parseArg("--port")) ??
      parseNumber(process.env["WORKFLOW_USAGE_PORT"]) ??
      DEFAULT_PORT;
    const host = parseArg("--host") ?? process.env["WORKFLOW_USAGE_HOST"] ?? DEFAULT_HOST;
    const databasePath =
      parseArg("--db-path") ?? process.env["WORKFLOW_USAGE_DB_PATH"] ?? undefined;

    const { baseUrl, mountRoute } = await startUsageTestServer({
      port,
      host,
      databasePath,
    });

    console.log(`Usage test server listening on ${baseUrl}${mountRoute}`);
  }
}
