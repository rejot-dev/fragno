import { describe, expect, test, assert } from "vitest";

import type { BackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

import type { DashboardCommandSpec } from "./dashboard-terminal";
import {
  formatPiTerminalCommandHelp,
  formatPiTerminalHelp,
  getAvailablePiTerminalCommandSpecs,
  PI_TERMINAL_COMMAND_SPECS,
} from "./pi-terminal-specs";

const specs: DashboardCommandSpec[] = [
  { command: "help", summary: "List the commands available in this terminal.", options: [] },
  { command: "ls", summary: "List files and directories.", options: [] },
  {
    command: "automations",
    summary: "List this organisation's automations.",
    options: [
      {
        name: "format",
        description: "Output format: text (default) or json",
        valueRequired: true,
        valueName: "format",
      },
    ],
  },
  { command: "store.get", summary: "Get an automation store entry by key.", options: [] },
  { command: "store.list", summary: "List automation store entries.", options: [] },
];

describe("formatPiTerminalHelp", () => {
  test("lists the curated commands grouped by namespace", () => {
    const output = formatPiTerminalHelp(specs);

    expect(output).toContain("Available commands:");
    expect(output).toContain("general:");
    expect(output).toContain("store.*:");
    expect(output).toContain("automations  List this organisation's automations.");
    expect(output).toContain("store.get");
    expect(output).toContain("Type '<command> --help' for details on a command.");
  });

  test("puts the general (non-namespaced) group first", () => {
    const output = formatPiTerminalHelp(specs);
    expect(output.indexOf("general:")).toBeLessThan(output.indexOf("store.*:"));
  });

  test("does not leak just-bash's own builtin list", () => {
    const output = formatPiTerminalHelp(specs);
    expect(output).not.toContain("just-bash shell builtins");
  });

  test("defaults to the real terminal command specs", () => {
    const output = formatPiTerminalHelp();
    expect(output).toContain("automations");
    expect(output).toContain("ls");
  });

  test("every real spec command appears in the listing", () => {
    const output = formatPiTerminalHelp();
    for (const spec of PI_TERMINAL_COMMAND_SPECS) {
      expect(output).toContain(spec.command);
    }
  });
});

describe("getAvailablePiTerminalCommandSpecs", () => {
  // Listing only reads `context.runtimes` (via each family's `isAvailable`); the
  // actor/scope/kernel fields are only used during tool execution, so a runtimes-only
  // stub is enough to drive availability here.
  const commandsFor = (runtimes: BackofficeToolContext["runtimes"]) =>
    getAvailablePiTerminalCommandSpecs({ runtimes } as unknown as BackofficeToolContext).map(
      (spec) => spec.command,
    );

  test("includes only the runtime-tool commands whose runtime is wired", () => {
    const commands = commandsFor({ telegram: {} });

    assert(commands.some((command) => command.startsWith("telegram.")));
    // The automation store runtime is not wired, so its commands are excluded.
    assert(!commands.some((command) => command.startsWith("store.")));
  });

  test("always includes the shell helper commands", () => {
    const commands = commandsFor({});

    expect(commands).toEqual(expect.arrayContaining(["ls", "help", "automations"]));
  });

  test("excludes hidden families even when their runtime is wired", () => {
    const commands = commandsFor({ internal: {} });

    assert(!commands.some((command) => command.startsWith("internal.")));
  });

  test("is a subset of the static superset", () => {
    const superset = new Set(PI_TERMINAL_COMMAND_SPECS.map((spec) => spec.command));
    const available = commandsFor({ telegram: {}, otp: {} });

    for (const command of available) {
      assert(superset.has(command));
    }
  });
});

describe("formatPiTerminalCommandHelp", () => {
  test("renders a known command with its options", () => {
    const output = formatPiTerminalCommandHelp("automations", specs);

    expect(output).toContain("automations [--format <format>]");
    expect(output).toContain("List this organisation's automations.");
    expect(output).toContain("--format: Output format: text (default) or json");
  });

  test("returns null for an unknown command", () => {
    expect(formatPiTerminalCommandHelp("nope", specs)).toBeNull();
  });
});
