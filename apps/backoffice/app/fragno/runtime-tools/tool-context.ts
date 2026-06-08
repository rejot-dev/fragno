import type { BashHostContext } from "./bash-host";
import type { CoreBackofficeToolContext } from "./tool-families";

export const createBackofficeToolContext = (
  context: BashHostContext,
): CoreBackofficeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    workflow: context.workflow?.runtime,
    durableHooks: context.durableHooks?.runtime,
    event: context.automation?.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    sandbox: context.sandbox?.runtime,
    telegram: context.telegram?.runtime,
  },
});
