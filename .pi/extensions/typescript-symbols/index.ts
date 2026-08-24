import { relative, resolve } from "node:path";

import { readTypeScriptFileOutline } from "@fragno-dev/typescript-symbols";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TYPESCRIPT_SYMBOLS_ENTRY = "typescript-symbols-output";

function commandFilePath(args: string): string | undefined {
  const value = args.trim();
  if (value.length === 0) {
    return undefined;
  }

  const quote = value[0];
  const unquoted =
    (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;

  return unquoted.startsWith("@") ? unquoted.slice(1) : unquoted;
}

/** Registers `/symbols <file>` to print a compact TypeScript declaration tree. */
export default function registerTypeScriptSymbolsCommand(pi: ExtensionAPI) {
  pi.registerEntryRenderer(TYPESCRIPT_SYMBOLS_ENTRY, (entry, _options, theme) => {
    return new Text(theme.fg("dim", String(entry.data)), 0, 0);
  });

  pi.registerCommand("symbols", {
    description: "Print a compact TypeScript declaration tree for a file",
    handler: async (args, ctx) => {
      const requestedPath = commandFilePath(args);
      if (!requestedPath) {
        ctx.ui.notify("Usage: /symbols <file>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, requestedPath);

      try {
        const outline = await readTypeScriptFileOutline(filePath);
        const displayedPath = relative(ctx.cwd, filePath) || filePath;
        pi.appendEntry(
          TYPESCRIPT_SYMBOLS_ENTRY,
          [displayedPath, outline].filter(Boolean).join("\n"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`TypeScript symbols failed: ${message}`, "error");
      }
    },
  });
}
