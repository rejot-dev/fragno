import { describe, expect, test } from "vitest";

import type { RouterContextProvider } from "react-router";

import { handlePiTerminalAction } from "./pi-terminal-action";

const runCommand = (command: string) => {
  const formData = new FormData();
  formData.set("intent", "run-command");
  formData.set("command", command);
  return handlePiTerminalAction({
    formData,
    request: new Request("https://backoffice.test/terminal", { method: "POST" }),
    // `help` is intercepted before any runtime context is read, so a throwing
    // context proves we never touch the bash host / filesystem for it.
    context: {
      get: () => {
        throw new Error("context.get should not be called for help");
      },
    } as unknown as Readonly<RouterContextProvider>,
    activeOrg: null,
    userId: "user-1",
  });
};

describe("handlePiTerminalAction help interception", () => {
  test("renders the curated command list without an active org", async () => {
    const result = await runCommand("help");

    expect(result).toMatchObject({ intent: "run-command", ok: true, exitCode: 0 });
    expect("output" in result && result.output).toContain("Available commands:");
    expect("output" in result && result.output).toContain("automations");
  });

  test("renders help for a single known command", async () => {
    const result = await runCommand("help store.list");

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect("output" in result && result.output).toContain("store.list");
  });

  test("reports unknown commands", async () => {
    const result = await runCommand("help totally-bogus");

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect("output" in result && result.output).toContain("No help available for 'totally-bogus'");
  });

  test("does not intercept help embedded in a larger command", async () => {
    // Falls through to the real shell path, which fails fast on the missing org.
    const result = await runCommand("help foo bar");

    expect(result).toMatchObject({ ok: false });
    expect("output" in result && result.output).toContain("No active organization");
  });
});
