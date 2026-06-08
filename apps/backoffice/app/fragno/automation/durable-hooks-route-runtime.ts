import { AUTH_SINGLETON_ID } from "@/cloudflare/cloudflare-utils";
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
  switch (fragment) {
    case "automations":
      return env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId)).getDurableHookRepository(
        "automation",
      );
    case "pi":
      return await env.PI.get(env.PI.idFromName(orgId)).getDurableHookRepository("pi");
    case "pi-workflows":
      return await env.PI.get(env.PI.idFromName(orgId)).getDurableHookRepository("workflows");
    case "telegram":
      return env.TELEGRAM.get(env.TELEGRAM.idFromName(orgId)).getDurableHookRepository();
    case "otp":
      return env.OTP.get(env.OTP.idFromName(orgId)).getDurableHookRepository();
    case "resend":
      return env.RESEND.get(env.RESEND.idFromName(orgId)).getDurableHookRepository();
    case "github":
      return env.GITHUB.get(env.GITHUB.idFromName(orgId)).getDurableHookRepository();
    case "upload":
      return env.UPLOAD.get(env.UPLOAD.idFromName(orgId)).getDurableHookRepository();
    case "cloudflare": {
      const repository = await env.CLOUDFLARE_WORKERS.get(
        env.CLOUDFLARE_WORKERS.idFromName(orgId),
      ).getDurableHookRepository();
      return {
        getHookQueue: async (options) => await repository.getHookQueue({ ...options, orgId }),
        getHook: async (hookId, options) => await repository.getHook(hookId, { ...options, orgId }),
      };
    }
    case "auth":
      return env.AUTH.get(env.AUTH.idFromName(AUTH_SINGLETON_ID)).getDurableHookRepository();
  }
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
