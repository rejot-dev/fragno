import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type {
  AutomationsObject,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import type { AutomationIdentityRuntime } from "@/fragno/runtime-tools/families/automations-identities";

export const createRouteBackedAutomationIdentityRuntime = ({
  object,
  execution,
}: {
  object: BackofficeObjectHandle<AutomationsObject>;
  execution: BackofficeExecutionContext;
}): AutomationIdentityRuntime => ({
  resolveExternal: async (identity) =>
    await object.commands.resolveExternalIdentity(
      {
        identity: {
          scope: "external",
          source: identity.source,
          type: identity.type,
          id: identity.id,
        },
      },
      { execution },
    ),
});
