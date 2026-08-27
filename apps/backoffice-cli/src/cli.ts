#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  backofficeErrorMessage,
  connectToBackoffice,
  executeBackofficeBash,
  executeBackofficeCodemode,
  fetchBackofficeSystemPrompt,
  parseBackofficeScope,
  probeBackofficeServer,
  resolveBackofficeAuthFile,
  resolveBackofficeDefaultScopeForServer,
} from "@rejot-dev/backoffice-local";

import { writeBackofficeSystemPrompt } from "./system-prompt-output.js";

const configuredBaseUrl = process.env["BACKOFFICE_URL"]?.replace(/\/$/, "") ?? null;
const packageJsonPath = new URL("../package.json", import.meta.url);
const cliVersion = JSON.parse(readFileSync(fileURLToPath(packageJsonPath), "utf8")).version;

function usage(exitCode = 1): never {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Backoffice CLI

Connect to Fragno Backoffice and run authenticated codemode operations.

Usage:
  backoffice <command> [options]

Commands:
  login                  Reuse stored authentication or sign in through the browser
  probe                  Print the selected Backoffice server URL
  doctor                 Verify authentication, SYSTEM.md, and read-only execution
  system [scope] [file]  Print SYSTEM.md or create an owner-only output file
  exec <scope> <code>    Execute a JavaScript codemode function
  bash <scope> <command> Execute a shell command in the scoped runtime

Scopes:
  system
  org:<orgId>
  project:<orgId>:<projectId>
  user:<userId>

Login options:
  --open                 Open the browser when device authorization is required
  --force                Ignore stored authentication and request new approval

Global options:
  --base-url URL         Select a Backoffice server instead of auto-discovery
  -h, --help             Show this help
  -v, --version          Show the CLI version

Examples:
  backoffice login --open
  backoffice doctor
  backoffice system org:org_123 ./SYSTEM.md
  backoffice exec org:org_123 'async () => await state.readdir({ path: "/" })'
  backoffice bash org:org_123 --cwd /workspace 'find . -maxdepth 2'

Environment:
  BACKOFFICE_URL          Default Backoffice server URL
  BACKOFFICE_AUTH_FILE    Override the credential file location
  BACKOFFICE_OPEN_BROWSER Open the browser during login when set to 1
`);
  process.exit(exitCode);
}

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function getFlag(
  args: string[],
  name: string,
  fallback: string | null | undefined,
): string | null | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function parsePositiveInteger(value: string | null | undefined, flag: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}. Expected a positive integer.`);
  }
  return number;
}

function parseDependencies(value: string | null | undefined): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid --dependencies JSON: ${backofficeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid --dependencies value. Expected a JSON object of package versions.");
  }
  const dependencies = parsed as Record<string, unknown>;
  if (Object.values(dependencies).some((version) => typeof version !== "string" || !version)) {
    throw new Error("Invalid --dependencies value. Every package version must be a string.");
  }
  return dependencies as Record<string, string>;
}

async function resolveCliBaseUrl(requestedBaseUrl: string | null | undefined): Promise<string> {
  return await probeBackofficeServer({ print: false, baseUrl: requestedBaseUrl ?? null });
}

async function login(args: string[]): Promise<void> {
  const openBrowser = takeFlag(args, "--open") || process.env["BACKOFFICE_OPEN_BROWSER"] === "1";
  const forceLogin = takeFlag(args, "--force");
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);

  const connection = await connectToBackoffice({
    baseUrl,
    openBrowser,
    forceLogin,
    onDeviceAuthorization: ({ verificationUrl, userCode }) => {
      console.log(`Open ${verificationUrl}`);
      console.log(`Enter code: ${userCode}`);
      console.log("Waiting for approval…");
    },
  });
  console.log(`Authenticated as ${connection.summary.user.email}`);
  console.error(
    connection.authentication === "stored"
      ? `Reused OAuth credential state from ${resolveBackofficeAuthFile()}`
      : `Stored OAuth credential state in ${resolveBackofficeAuthFile()}`,
  );
  console.log(JSON.stringify(connection.summary, null, 2));
}

async function doctor(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const scope = await resolveBackofficeDefaultScopeForServer({ baseUrl });
  const systemPrompt = await fetchBackofficeSystemPrompt({ baseUrl, scope });
  const result = await executeBackofficeCodemode({
    baseUrl,
    scope,
    code: 'async () => ({ rootEntries: await state.readdir({ path: "/" }) })',
  });
  console.log(
    JSON.stringify({ ok: true, baseUrl, systemPrompt: systemPrompt.length > 0, result }, null, 2),
  );
}

async function fetchSystem(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const scopeArg = args.shift();
  const outputFile = args.shift() ?? null;
  if (args.length > 0) {
    usage();
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const systemPrompt = await fetchBackofficeSystemPrompt({
    baseUrl,
    ...(scopeArg ? { scope: parseBackofficeScope(scopeArg) } : {}),
  });
  const destination = await writeBackofficeSystemPrompt({
    systemPrompt,
    outputFile,
    writeStdout(content) {
      process.stdout.write(content);
    },
  });
  if (destination.kind === "file") {
    console.log(destination.outputFile);
  }
}

async function execCodemode(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const timeout = parsePositiveInteger(getFlag(args, "--timeout", undefined), "--timeout");
  const dependencies = parseDependencies(getFlag(args, "--dependencies", undefined));
  const file = getFlag(args, "--file", undefined);
  const scopeArg = args.shift();
  const codeArg = args.shift();
  if (!scopeArg || args.length > 0) {
    usage();
  }
  const code = file ? await readFile(file, "utf8") : codeArg === "-" ? await readStdin() : codeArg;
  if (!code) {
    usage();
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const result = await executeBackofficeCodemode({
    baseUrl,
    scope: parseBackofficeScope(scopeArg),
    code,
    ...(dependencies ? { dependencies } : {}),
    ...(timeout ? { timeout } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function execBash(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const timeout = parsePositiveInteger(getFlag(args, "--timeout", undefined), "--timeout");
  const cwd = getFlag(args, "--cwd", undefined);
  const file = getFlag(args, "--file", undefined);
  const scopeArg = args.shift();
  const commandArg = args.shift();
  if (!scopeArg || args.length > 0) {
    usage();
  }
  const command = file
    ? await readFile(file, "utf8")
    : commandArg === "-"
      ? await readStdin()
      : commandArg;
  if (!command) {
    usage();
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const result = await executeBackofficeBash({
    baseUrl,
    scope: parseBackofficeScope(scopeArg),
    command,
    ...(cwd ? { cwd } : {}),
    ...(timeout ? { timeout } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runBackofficeCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      usage(0);
    }
    if (command === "--version" || command === "-v") {
      console.log(cliVersion);
    } else if (command === "login") {
      await login(args);
    } else if (command === "probe") {
      const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
      if (args.length > 0) {
        usage();
      }
      await probeBackofficeServer({ baseUrl });
    } else if (command === "doctor") {
      await doctor(args);
    } else if (command === "system") {
      await fetchSystem(args);
    } else if (command === "exec") {
      await execCodemode(args);
    } else if (command === "bash") {
      await execBash(args);
    } else {
      console.error(`Unknown command: ${command}\n`);
      usage();
    }
  } catch (error) {
    console.error(`Backoffice CLI error: ${backofficeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runBackofficeCli();
}
