import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/cloudflare-do";
import type { NodeRuntimeObjectContext } from "@fragno-private/backoffice-node-runtime/node-runtime-object";
import { Kysely } from "kysely";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject, type AuthDatabase } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../workers/billing.do";
import { InMemoryCloudflareObject } from "../../../workers/cloudflare.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../workers/github.do";
import { noOpBackofficeConfiguredObjectLifecycle } from "../../../workers/lib/backoffice-fragment-durable-object";
import {
  createPiDurableHarnessOptions,
  createPiDurableModels,
  listSupportedPiDurableModels,
} from "../../../workers/lib/pi-durable-harness-options";
import { openPiSessionStore } from "../../../workers/lib/pi-session-store";
import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryPiManagerObject } from "../../../workers/pi-manager.do";
import { InMemoryPiObject } from "../../../workers/pi.do";
import { InMemoryProjectConnectorObject } from "../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../workers/resend.do";
import { InMemoryReson8Object } from "../../../workers/reson8.do";
import { InMemorySandboxManagerObject } from "../../../workers/sandbox-manager.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { piAgentObjectName, type PiAgent } from "../../fragno/pi-manager/pi-agent-contract";
import { createDurableObjectDatabaseAdapterScope } from "../database-adapters";
import type { GraftBackofficeObjectBinding } from "./graft-object-definitions";
import {
  createGraftBackofficeCommands,
  createGraftBackofficeObjectId,
  type GraftBackofficeObjectResolver,
} from "./graft-object-registry";
import {
  createGraftBackofficeRuntimeServices,
  type GraftBackofficeConfiguration,
} from "./graft-runtime-services";
import { createNodeBackofficeObjectImplementation } from "./node-object-implementation";
import { shutdownNodeOpenTelemetry } from "./node-opentelemetry-lifecycle";

/** Definition input contains data only; all application dependencies are constructed in the worker. */
export type GraftBackofficeObjectInput = {
  binding: GraftBackofficeObjectBinding;
  configuration: GraftBackofficeConfiguration;
};

/** Imports ordinary InMemory objects into the fenced worker without creating a second runtime. */
export function createGraftBackofficeObject(
  context: NodeRuntimeObjectContext<GraftBackofficeObjectInput>,
): object {
  context.onShutdown(shutdownNodeOpenTelemetry);
  const resolve: GraftBackofficeObjectResolver = (binding, name) =>
    context.objects.get(binding, name);
  const { env, services, createSandboxProviders } = createGraftBackofficeRuntimeServices({
    configuration: context.input.configuration,
    resolve,
    nowEpochMs: context.nowEpochMs,
  });
  const state = context.state;
  const runtime = {
    ...services,
    adapters: services.adapters.forScope(createDurableObjectDatabaseAdapterScope(state)),
  };
  const implementation = createNodeBackofficeObjectImplementation({
    state,
    env,
    runtime,
    // A worker has sole write ownership; config changes already refresh their local host.
    configuredObjectLifecycle: noOpBackofficeConfiguredObjectLifecycle,
    fragmentHostOperations: {
      createDispatcher({ hookFragments, state, env, instrumentation, onProcessError }) {
        return createDurableHooksProcessor(
          hookFragments,
          { instrumentation, onProcessError },
          "serial",
        )(state, env);
      },
    },
  });
  const common = { state, env, runtime, implementation };
  switch (context.input.binding) {
    case "API":
      return new InMemoryApiObject(common);
    case "AUTH": {
      const database = new Kysely<AuthDatabase>({
        dialect: new DurableObjectDialect({ ctx: state, queryInstrumentation: null }),
      });
      context.onShutdown(() => database.destroy());
      return new InMemoryAuthObject({ state, env: env as never, runtime, database });
    }
    case "TELEGRAM":
      return new InMemoryTelegramObject(common);
    case "RESEND":
      return new InMemoryResendObject(common);
    case "RESON8":
      return new InMemoryReson8Object(common);
    case "MCP":
      return new InMemoryMcpObject(common);
    case "PROJECT_CONNECTOR":
      return new InMemoryProjectConnectorObject(common);
    case "OTP":
      return new InMemoryOtpObject(common);
    case "UPLOAD":
      return new InMemoryUploadObject({ ...common, env: env as never });
    case "SANDBOX_MANAGER":
      return new InMemorySandboxManagerObject({
        ...common,
        sandboxProviders: createSandboxProviders(state.id.toString()),
      });
    case "GITHUB":
      return new InMemoryGitHubObject({ ...common, env: env as never });
    case "GITHUB_WEBHOOK_ROUTER":
      return new InMemoryGitHubWebhookRouterObject({ state, env: env as never, runtime });
    case "CLOUDFLARE":
      return new InMemoryCloudflareObject(common);
    case "FORMS":
      return new InMemoryFormsObject(common);
    case "AUTOMATIONS":
      return new InMemoryAutomationsObject({ ...common, nowEpochMs: context.nowEpochMs });
    case "PI": {
      let storage: ReturnType<typeof openPiSessionStore> | null = null;
      const object = new InMemoryPiObject({
        state,
        options: createPiDurableHarnessOptions(env),
        runtime,
        openStorage: () => (storage ??= openPiSessionStore(state.storage)),
        idFromConfig: (config) => createGraftBackofficeObjectId("PI", piAgentObjectName(config)),
        nowEpochMs: context.nowEpochMs,
      });
      context.onShutdown(async () => {
        try {
          await object.close();
        } finally {
          if (storage !== null) {
            await (await storage).close(BACKGROUND_CONTEXT);
          }
        }
      });
      return object;
    }
    case "PI_MANAGER": {
      const models = createPiDurableModels(env);
      return new InMemoryPiManagerObject({
        ...common,
        agent: (config) =>
          createGraftBackofficeCommands(resolve, "PI", piAgentObjectName(config)) as PiAgent,
        supportedAvailableModels: () => listSupportedPiDurableModels(models),
        nowEpochMs: context.nowEpochMs,
      });
    }
    case "BILLING":
      return new InMemoryBillingObject(common);
    case "MARKETPLACE":
      return new InMemoryMarketplaceObject(common);
    default: {
      const unhandledBinding: never = context.input.binding;
      throw new Error("BACKOFFICE_GRAFT_OBJECT_BINDING_UNHANDLED", { cause: unhandledBinding });
    }
  }
}
