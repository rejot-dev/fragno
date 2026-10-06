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
    eventCatalog: context.eventCatalog?.runtime,
    forms: context.forms?.runtime,
    github: context.github?.runtime,
    integrations: context.integrations?.runtime,
    internal: context.internal?.runtime,
    api: context.api?.runtime,
    mcp: context.mcp?.runtime,
    marketplace: context.marketplace?.runtime,
    packages: context.packages?.runtime,
    projectConnector: context.projectConnector?.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    sandbox: context.sandbox?.runtime,
    telegram: context.telegram?.runtime,
    javascript: context.javascript?.runtime,
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
