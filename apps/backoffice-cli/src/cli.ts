#!/usr/bin/env node
import { once } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  backofficeErrorMessage,
  connectToBackoffice,
  downloadBackofficeFile,
  executeBackofficeBash,
  executeBackofficeCodemode,
  fetchBackofficeSystemPrompt,
  listBackofficeAvailableScopesForServer,
  openBackofficeAutomationsStream,
  parseBackofficeScope,
  probeBackofficeServer,
  resolveBackofficeAuthFile,
  resolveBackofficeDefaultScopeForServer,
  uploadBackofficeWorkspaceFile,
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
  scopes                 Print scopes available to the authenticated user
  probe                  Print the selected Backoffice server URL
  doctor                 Verify authentication, SYSTEM.md, and read-only execution
  system [scope] [file]  Print SYSTEM.md or create an owner-only output file
  listen <scope>         Listen to the scoped Automations NDJSON mutation stream
  exec <scope> <code>    Execute a JavaScript codemode function
  bash <scope> <command> Execute a shell command in the scoped runtime
  upload <scope> <local-file> <workspace-path>
                         Upload a local file into Backoffice /workspace
  download <scope> <backoffice-path> <local-file>
                         Download a Backoffice file locally

Scope syntax:
  system
  org:<organization-slug>
  project:<organization-slug>:<project-id>
  user:<user-id>

  Organization scopes always use the slug after org:, never the internal organization ID.
  Run 'backoffice scopes' to print the exact values available to you.

Login options:
  --open                 Open the browser when device authorization is required
  --force                Ignore stored authentication and request new approval

Listen options:
  --after-versionstamp VALUE
                         Resume after an Automations stream versionstamp

Global options:
  --base-url URL         Select a Backoffice server instead of auto-discovery
  -h, --help             Show this help
  -v, --version          Show the CLI version

Examples:
  backoffice login --open
  backoffice scopes
  backoffice doctor
  backoffice system org:acme ./SYSTEM.md
  backoffice listen org:acme
  backoffice exec org:acme 'async () => await state.readdir({ path: "/" })'
  backoffice bash org:acme --cwd /workspace 'find . -maxdepth 2'
  backoffice upload org:acme ./report.pdf /workspace/reports/report.pdf
  backoffice download org:acme /workspace/reports/report.pdf ./report.pdf

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

async function printAvailableScopes(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }

  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const scopes = await listBackofficeAvailableScopesForServer({ baseUrl });
  const argumentWidth = Math.max(...scopes.map((scope) => scope.argument.length));

  console.log("Available Backoffice scopes:");
  for (const scope of scopes) {
    const defaultLabel = scope.isDefault ? " (default)" : "";
    console.log(`  ${scope.argument.padEnd(argumentWidth)}  ${scope.label}${defaultLabel}`);
  }
  console.log("\nOrganization scopes use slugs after org:, never internal organization IDs.");
  console.log("Project scope syntax: project:<organization-slug>:<project-id>");
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

async function writeAutomationStreamLine(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) {
    await once(process.stdout, "drain");
  }
}

async function consumeAutomationStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  afterVersionstamp: string | undefined,
): Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };

  if (signal.aborted) {
    cancelReader();
  } else {
    signal.addEventListener("abort", cancelReader, { once: true });
  }

  async function consumeCompleteLines(final: boolean): Promise<void> {
    const lines = buffer.split("\n");
    buffer = final ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const entry = JSON.parse(line) as { versionstamp: string };
      await writeAutomationStreamLine(line);
      afterVersionstamp = entry.versionstamp;
    }
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        buffer += decoder.decode();
        await consumeCompleteLines(true);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      await consumeCompleteLines(false);
    }
    return afterVersionstamp;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!completed) {
      await reader.cancel(signal.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}

async function waitForAutomationStreamReconnect(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, 1_000);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function listenToAutomations(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  let afterVersionstamp = getFlag(args, "--after-versionstamp", undefined) ?? undefined;
  const scopeArg = args.shift();
  if (!scopeArg || args.length > 0) {
    usage();
  }

  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const scope = parseBackofficeScope(scopeArg);
  const abortController = new AbortController();
  let hasOpenedStream = false;
  const stopListening = () => {
    abortController.abort();
  };
  process.once("SIGINT", stopListening);
  process.once("SIGTERM", stopListening);

  try {
    while (!abortController.signal.aborted) {
      try {
        const stream = await openBackofficeAutomationsStream({
          baseUrl,
          scope,
          afterVersionstamp,
          signal: abortController.signal,
        });
        hasOpenedStream = true;
        afterVersionstamp = await consumeAutomationStream(
          stream,
          abortController.signal,
          afterVersionstamp,
        );
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        if (!hasOpenedStream) {
          throw error;
        }
        console.error(
          `Automations stream disconnected: ${backofficeErrorMessage(error)} Retrying…`,
        );
      }

      await waitForAutomationStreamReconnect(abortController.signal);
    }
  } finally {
    process.removeListener("SIGINT", stopListening);
    process.removeListener("SIGTERM", stopListening);
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

function backofficeWorkspaceFileKey(path: string): string {
  if (path.startsWith("/") && !path.startsWith("/workspace/")) {
    throw new Error("Workspace path must identify a file inside /workspace.");
  }
  const fileKey = path.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  if (!fileKey || fileKey.split("/").includes("..")) {
    throw new Error("Workspace path must identify a file inside /workspace.");
  }
  return fileKey;
}

async function uploadFile(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const scopeArg = args.shift();
  const localFile = args.shift();
  const workspacePath = args.shift();
  if (!scopeArg || !localFile || !workspacePath || args.length > 0) {
    usage();
  }

  const fileKey = backofficeWorkspaceFileKey(workspacePath);
  const sourcePath = resolve(localFile);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Local upload source is not a file: ${sourcePath}`);
  }
  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  await uploadBackofficeWorkspaceFile({
    baseUrl,
    scope: parseBackofficeScope(scopeArg),
    fileKey,
    content: Readable.toWeb(createReadStream(sourcePath)) as ReadableStream<Uint8Array>,
    sizeBytes: sourceStat.size,
    contentType: "application/octet-stream",
  });
  console.log(`Uploaded ${sourcePath} to /workspace/${fileKey} (${sourceStat.size} bytes).`);
}

async function downloadFile(args: string[]): Promise<void> {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const scopeArg = args.shift();
  const backofficePath = args.shift();
  const localFile = args.shift();
  if (!scopeArg || !backofficePath || !localFile || args.length > 0) {
    usage();
  }

  const baseUrl = await resolveCliBaseUrl(requestedBaseUrl);
  const content = await downloadBackofficeFile({
    baseUrl,
    scope: parseBackofficeScope(scopeArg),
    path: backofficePath,
  });
  const destination = resolve(localFile);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  console.log(`Downloaded ${backofficePath} to ${destination} (${content.byteLength} bytes).`);
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
    } else if (command === "scopes") {
      await printAvailableScopes(args);
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
    } else if (command === "listen") {
      await listenToAutomations(args);
    } else if (command === "exec") {
      await execCodemode(args);
    } else if (command === "bash") {
      await execBash(args);
    } else if (command === "upload") {
      await uploadFile(args);
    } else if (command === "download") {
      await downloadFile(args);
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
