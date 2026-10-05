import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import { createInteractiveRuntimeBashHost, type BashHost, type BashHostContext } from "./bash-host";
import { createStateShellFileSystem } from "./state-shell-file-system";

export type AutomationScriptHostContext = BashHostContext & {
  automation: NonNullable<BashHostContext["automation"]>;
};

type CreateInteractiveBashHostInput = {
  sessionId?: string;
  context: BashHostContext & { stateBackend: BackofficeStateBackend };
};

/** Runs shell commands against the same scoped state backend as codemode and PI. */
export function createInteractiveBashHost(input: CreateInteractiveBashHostInput): BashHost {
  return createInteractiveRuntimeBashHost({
    fs: createStateShellFileSystem(input.context.stateBackend),
    sessionId: input.sessionId,
    context: input.context,
  });
}
