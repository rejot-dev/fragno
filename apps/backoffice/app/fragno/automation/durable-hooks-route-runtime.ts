import { getHookScope } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type {
  DurableHookQueueOptions,
  DurableHookQueueResponse,
  DurableHookRepository,
} from "@/fragno/durable-hooks";
import type {
  DurableHookFragment,
  DurableHooksRuntime,
} from "@/fragno/runtime-tools/families/automations-durable-hooks";

type FragmentDurableHookRepository = DurableHookRepository<DurableHookQueueOptions>;

const getDurableHookRepository = async ({
  env,
  orgId,
  fragment,
}: {
  env: CloudflareEnv;
  orgId: string;
  fragment: DurableHookFragment;
}): Promise<FragmentDurableHookRepository> => {
  const scope = getHookScope(fragment);
  if (!scope) {
    throw new Error(
      `Unknown hook fragment '${fragment}'. Run hooks.scopes.list to discover available hook scopes.`,
    );
  }
  return await scope.getRepository({ env, orgId });
};

export const createRouteBackedDurableHooksRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): DurableHooksRuntime => ({
  listHooks: async ({ fragment, cursor, pageSize }): Promise<DurableHookQueueResponse> => {
    const repository = await getDurableHookRepository({ env, orgId, fragment });
    return await repository.getHookQueue({ cursor, pageSize });
  },
  getHook: async ({ fragment, hookId }) => {
    const repository = await getDurableHookRepository({ env, orgId, fragment });
    return await repository.getHook(hookId);
  },
});
