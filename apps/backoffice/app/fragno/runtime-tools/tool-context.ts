import type { BashHostContext } from "./bash-host";
import type { CoreBackofficeToolContext } from "./tool-families";

export const createBackofficeToolContext = (
  context: BashHostContext,
): CoreBackofficeToolContext => {
  const kernel = context.backofficeKernel;
  const runtimes = {
    state: context.stateBackend,
    admin: context.admin?.runtime,
    backoffice: context.backoffice?.runtime,
    cloudflare: context.cloudflare?.runtime,
    automations: context.automations?.runtime,
    identity: context.identity?.runtime,
    workflow: context.workflow?.runtime,
    durableHooks: context.durableHooks?.runtime,
    event: context.automation?.runtime ?? context.event?.runtime,
    forms: context.forms?.runtime,
    internal: context.internal?.runtime,
    api: context.api?.runtime,
    mcp: context.mcp?.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    sandbox: context.sandbox?.runtime,
    telegram: context.telegram?.runtime,
    upload: context.upload?.runtime,
    web: context.web?.runtime,
  };

  return {
    execution: context.execution,
    kernel,
    createScopedContext: (scope) =>
      createBackofficeToolContext(context.createBackofficeScopedContext(scope)),
    runtimes,
  };
};
