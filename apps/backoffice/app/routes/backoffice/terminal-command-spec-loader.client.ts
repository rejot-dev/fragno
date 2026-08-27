import type { DashboardCommandSpec } from "./dashboard-terminal";

let terminalCommandSpecsPromise: Promise<readonly DashboardCommandSpec[]> | null = null;

/** Loads generated terminal metadata only after the interactive terminal is opened. */
export function loadBackofficeTerminalCommandSpecs(): Promise<readonly DashboardCommandSpec[]> {
  terminalCommandSpecsPromise ??= import("../../../content/static/terminal/terminal-spec.json")
    .then(({ default: commandSpecs }) => commandSpecs as readonly DashboardCommandSpec[])
    .catch((error: unknown) => {
      terminalCommandSpecsPromise = null;
      throw error;
    });
  return terminalCommandSpecsPromise;
}
