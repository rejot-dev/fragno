import { SYSTEM_BACKOFFICE_PRINCIPAL } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";

import type { BashHostContext } from "./bash-host";

const EMPTY_BASH_HOST_KERNEL = new BackofficeKernel({});

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  defaultActor: null,
  backofficeExecution: { actor: SYSTEM_BACKOFFICE_PRINCIPAL, scope: { kind: "system" } },
  backofficeKernel: EMPTY_BASH_HOST_KERNEL,
  createBackofficeScopedContext: (scope) => ({
    ...EMPTY_BASH_HOST_CONTEXT,
    backofficeExecution: { actor: SYSTEM_BACKOFFICE_PRINCIPAL, scope },
  }),
  backoffice: null,
  automation: null,
  automations: null,
  workflow: null,
  durableHooks: null,
  internal: null,
  mcp: null,
  otp: null,
  pi: null,
  reson8: null,
  resend: null,
  sandbox: null,
  telegram: null,
};
