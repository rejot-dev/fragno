import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type {
  AutomationsCommands,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import type { AutomationIdentityRuntime } from "@/fragno/runtime-tools/families/automations-identities";

const DEFAULT_EXTERNAL_IDENTITY_PAGE_SIZE = 100;

export const createRouteBackedAutomationIdentityRuntime = ({
  object,
  execution,
}: {
  object: BackofficeObjectHandle<AutomationsCommands>;
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
  listExternal: async ({ limit, cursor }) => {
    const page = await object.commands.listExternalIdentityBindings(
      { pageSize: limit ?? DEFAULT_EXTERNAL_IDENTITY_PAGE_SIZE, cursor: cursor ?? null },
      { execution },
    );
    return {
      bindings: page.bindings.map((binding) => ({
        id: binding.id,
        source: binding.identity.source,
        type: binding.identity.type,
        externalId: binding.identity.id,
        userId: binding.userId,
        verifiedByClaimId: binding.verifiedByClaimId,
        status: binding.status,
        boundAt: binding.boundAt.toISOString(),
        revokedAt: binding.status === "revoked" ? binding.revokedAt.toISOString() : null,
      })),
      nextCursor: page.cursor,
    };
  },
});
