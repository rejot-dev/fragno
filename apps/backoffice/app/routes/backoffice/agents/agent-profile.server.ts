import type { PiAgentSkillListing } from "@fragno-dev/backoffice-api/v0/pi";
import { piAgentNameSchema } from "@fragno-dev/backoffice-api/v0/shared/pi-agent-name";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  PiManagerRuntimeRequestError,
  createPiManagerRuntime,
} from "@/fragno/pi/manager/pi-manager-runtime";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export type PiAgentSkillsLookup =
  | { listed: true; skills: PiAgentSkillListing }
  | { listed: false; message: string };

/**
 * Every skill an agent finds, read with the reader's own authority. The rest of its profile comes
 * from the synchronized directory, which follows its definition as it changes.
 */
export async function fetchPiAgentSkills(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<PiAgentSkillsLookup> {
  if (!piAgentNameSchema.safeParse(agentName).success) {
    return { listed: false, message: "Not an agent name." };
  }
  const execution = await requireBackofficeContext(request, context, scope);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  try {
    const skills = await createPiManagerRuntime({
      runtime,
      kernel,
      execution,
      caller: { kind: "none" },
    }).listAgentSkills({ agentName });
    return { listed: true, skills };
  } catch (error) {
    if (error instanceof PiManagerRuntimeRequestError) {
      return { listed: false, message: error.message };
    }
    if (isBackofficeForbiddenError(error)) {
      return { listed: false, message: "Reading its skills needs permission to read files." };
    }
    throw error;
  }
}
