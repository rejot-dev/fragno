/*
 * The `automations` terminal command — a thin wrapper around listing the org's
 * automations directory. It is essentially `ls` over the two automation roots
 * (`/system/automations` and `/workspace/automations`), but it understands the
 * workspace layout: it recurses, skips missing roots, and annotates each script
 * with its layer, kind, and engine.
 *
 * Server-only: it reads the org filesystem through `listAutomationWorkspaceScripts`.
 * It is registered as a custom bash command (see `bash-host.ts`), so both the
 * backoffice dashboard terminal and the Cadence dev console can run it.
 */

import { defineCommand } from "just-bash";

import type { IFileSystem } from "@/files/interface";
import {
  listAutomationWorkspaceScripts,
  type AutomationWorkspaceScriptEntry,
} from "@/fragno/automation/catalog";

const HELP_TEXT = [
  "Usage: automations [list] [--format text|json]",
  "",
  "List the automations available to this organisation. This wraps an `ls` over",
  "the automation roots (/system/automations and /workspace/automations).",
  "",
  "Commands:",
  "  automations            List automations (default).",
  "  automations list       List automations.",
  "",
  "Options:",
  "  --format <text|json>   Output format. Defaults to text.",
  "  --help                 Show this help text.",
  "",
].join("\n");

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({ stdout: "", stderr, exitCode });

type AutomationsFormat = "text" | "json";

const parseArgs = (
  args: string[],
): { command: string; format: AutomationsFormat; help: boolean } => {
  let command = "list";
  let format: AutomationsFormat = "text";
  let help = false;
  let sawCommand = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg.includes("=") ? arg.slice("--format=".length) : args[(index += 1)];
      if (value !== "text" && value !== "json") {
        throw new Error("--format must be 'text' or 'json'.");
      }
      format = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option '${arg}'.`);
    }

    if (!sawCommand) {
      command = arg;
      sawCommand = true;
      continue;
    }

    throw new Error(`unexpected argument '${arg}'.`);
  }

  return { command, format, help };
};

const formatEntriesText = (entries: readonly AutomationWorkspaceScriptEntry[]): string => {
  if (entries.length === 0) {
    return "No automations found.\n";
  }

  const layerWidth = Math.max(...entries.map((entry) => entry.layer.length));
  const kindWidth = Math.max(...entries.map((entry) => entry.kind.length));
  const engineWidth = Math.max(...entries.map((entry) => entry.engine.length));

  return `${entries
    .map((entry) => {
      const layer = entry.layer.padEnd(layerWidth);
      const kind = entry.kind.padEnd(kindWidth);
      const engine = entry.engine.padEnd(engineWidth);
      return `${layer}  ${kind}  ${engine}  ${entry.absolutePath}`;
    })
    .join("\n")}\n`;
};

export const automationsCommand = defineCommand("automations", async (args, ctx) => {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return fail(`automations: ${error instanceof Error ? error.message : String(error)}\n`, 2);
  }

  if (parsed.help) {
    return ok(HELP_TEXT);
  }

  if (parsed.command !== "list") {
    return fail(`automations: unknown command '${parsed.command}'.\n`, 2);
  }

  try {
    // At runtime `ctx.fs` is the org filesystem (the `@/files` IFileSystem); the
    // just-bash type is narrower but structurally identical.
    const entries = await listAutomationWorkspaceScripts(ctx.fs as unknown as IFileSystem);

    if (parsed.format === "json") {
      return ok(`${JSON.stringify(entries, null, 2)}\n`);
    }

    return ok(formatEntriesText(entries));
  } catch (error) {
    return fail(`automations: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
