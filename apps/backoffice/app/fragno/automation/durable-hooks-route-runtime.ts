import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { getHookScope } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { DurableHookQueueResponse, DurableHookRepository } from "@/fragno/durable-hooks";
import type {
  DurableHookFragment,
  DurableHooksRuntime,
} from "@/fragno/runtime-tools/families/automations-durable-hooks";

type FragmentDurableHookRepository = DurableHookRepository;

const getDurableHookRepository = async ({
  objects,
  config,
  orgId,
  fragment,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
  fragment: DurableHookFragment;
}): Promise<FragmentDurableHookRepository> => {
  const scope = getHookScope(fragment);
  if (!scope) {
    throw new Error(
      `Unknown hook fragment '${fragment}'. Run hooks.scopes.list to discover available hook scopes.`,
    );
  }
  return await scope.getRepository({
    objects,
    config,
    scope: { kind: "org", orgId },
    orgId,
    origin: "https://backoffice.local",
  });
};

export const createRouteBackedDurableHooksRuntime = ({
  objects,
  config,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
}): DurableHooksRuntime => ({
  listHooks: async ({ fragment, cursor, pageSize }): Promise<DurableHookQueueResponse> => {
    const repository = await getDurableHookRepository({ objects, config, orgId, fragment });
    return await repository.getHookQueue({ cursor, pageSize });
  },
  getHook: async ({ fragment, hookId }) => {
    const repository = await getDurableHookRepository({ objects, config, orgId, fragment });
    return await repository.getHook(hookId);
  },
});
