import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";

import type { BashHostContext } from "./bash-host";

const EMPTY_BASH_HOST_KERNEL = new BackofficeKernel({
  authorityResolver: unrestrictedBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
});

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  execution: {
    scope: { kind: "system" },
    actors: {
      initiator: { scope: "internal", type: "system", id: "backoffice", role: "initiator" },
      principal: null,
      delegation: [],
    },
  },
  backofficeKernel: EMPTY_BASH_HOST_KERNEL,
  createBackofficeScopedContext: (scope) => ({
    ...EMPTY_BASH_HOST_CONTEXT,
    execution: { ...EMPTY_BASH_HOST_CONTEXT.execution, scope },
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
