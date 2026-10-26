import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { getHookScope } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { DurableHookQueueResponse, DurableHookRepository } from "@/fragno/durable-hooks";
import type {
  DurableHookFragment,
  DurableHooksRuntime,
} from "@/fragno/runtime-tools/families/automations-durable-hooks";

type FragmentDurableHookRepository = DurableHookRepository;

const resolveDurableHookRepository = async ({
  objects,
  config,
  organization,
  fragment,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  organization: BackofficeOrganizationContextScope;
  fragment: DurableHookFragment;
}): Promise<FragmentDurableHookRepository> => {
  const scope = getHookScope(fragment);
  if (!scope) {
    throw new Error(
      `Unknown hook fragment '${fragment}'. Run hooks.scopes.list to discover available hook scopes.`,
    );
  }
  return await scope.getRepository({ objects, config, scope: organization, organization });
};

export const createRouteBackedDurableHooksRuntime = ({
  objects,
  config,
  organization,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  organization: BackofficeOrganizationContextScope;
}): DurableHooksRuntime => ({
  listHooks: async ({ fragment, cursor, pageSize }): Promise<DurableHookQueueResponse> => {
    const repository = await resolveDurableHookRepository({
      objects,
      config,
      organization,
      fragment,
    });
    return await repository.getHookQueue({ cursor, pageSize });
  },
  getHook: async ({ fragment, hookId }) => {
    const repository = await resolveDurableHookRepository({
      objects,
      config,
      organization,
      fragment,
    });
    return await repository.getHook(hookId);
  },
});
