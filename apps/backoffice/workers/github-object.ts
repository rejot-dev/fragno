import {
  getGitHubAppFromFragment,
  GITHUB_APP_FALLBACK_LINK_KEY,
  type GitHubRepositoryLinkStatus,
} from "@fragno-dev/github-app-fragment";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  type GitHubCommands,
  requireBackofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  buildGitHubAutomationEvent,
  createGitHubServer,
  type GitHubFragment,
  type GitHubInstallationOwner,
} from "@/fragno/github";
import { encodeGitHubRepositoryConnectionId } from "@/fragno/runtime-tools/families/integrations/github-integration";
import { recordIntegrationConnectionState } from "@/fragno/runtime-tools/families/integrations/integration-events";

import {
  configsEqual,
  extractFragmentConfig,
  resolveGitHubConfig,
  type GitHubAppEnvironmentConfig,
} from "./github.shared";
import type {
  BackofficeFragmentDurableObject,
  BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

type StoredGitHubConfig = {
  scope: GitHubInstallationOwner;
  source: GitHubAppEnvironmentConfig;
};

/** Processed deliveries stay readable for agents and debugging; their automation events outlive them. */
const GITHUB_WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function connectionStateOfLink(status: GitHubRepositoryLinkStatus) {
  switch (status) {
    case "active":
      return "ready";
    case "inactive":
      return "unavailable";
    case "unlinked":
      return "disconnected";
    default:
      throw new Error("Unknown GitHub repository link status.", {
        cause: status satisfies never,
      });
  }
}

export class GitHubObject implements GitHubCommands {
  readonly #scope: GitHubInstallationOwner;
  readonly #httpTransport: ReturnType<typeof createBackofficeFragmentHttpTransport>;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<
    StoredGitHubConfig,
    GitHubAppEnvironmentConfig,
    GitHubFragment
  >;
  readonly #configResolution: ReturnType<typeof resolveGitHubConfig>;

  constructor({
    state,
    env,
    nowEpochMs,
    runtime,
    implementation,
    fetch: fetchImpl = fetch,
  }: {
    state: BackofficeObjectState;
    env: Parameters<typeof resolveGitHubConfig>[0] &
      Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    fetch?: typeof fetch;
  }) {
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "GITHUB");
    if (scope.kind !== "org" && scope.kind !== "user") {
      throw new Error("GitHub Durable Objects belong to organizations and personal workspaces.");
    }
    this.#scope = scope;
    this.#httpTransport = createBackofficeFragmentHttpTransport({
      address: {
        binding: "GITHUB",
        scope: backofficeObjectScopeFromContextScope(scope),
      },
      env,
      nowEpochMs,
    });
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#configResolution = resolveGitHubConfig(env);
    this.#host = implementation.createConfiguredFragmentHost({
      name: "GitHub",
      toSource: (stored) => stored.source,
      fingerprint: (source) => JSON.stringify(source),
      createRuntime: (config) =>
        createGitHubServer(
          {
            ...config,
            webhookDeliveryRetentionMs: GITHUB_WEBHOOK_DELIVERY_RETENTION_MS,
            fetch: fetchImpl,
            onRepositoryLinkStatusChanged: async (payload, context) => {
              // Integrations link only under the default key; other keys are not connections.
              if (payload.linkKey !== (config.defaultLinkKey ?? GITHUB_APP_FALLBACK_LINK_KEY)) {
                return;
              }
              const { scope } = this.#host.requireConfigured().stored;
              const state = connectionStateOfLink(payload.status);
              await recordIntegrationConnectionState(
                this.#runtimeServices.objects.automations.for(scope).commands,
                {
                  id: context.hookId.toString(),
                  scope,
                  service: "github",
                  connectionId: encodeGitHubRepositoryConnectionId(payload.fullName),
                  ...(state === "disconnected"
                    ? { state }
                    : { state, label: { name: payload.fullName, authMethod: "app-installation" } }),
                  occurredAt: context.createdAt,
                },
                { propagationContext: context.capturePropagationContext() },
              );
            },
            webhook: (register) => {
              register("*", async (event, _idempotencyKey, meta) => {
                const runtime = this.#host.getConfigured();
                if (!runtime) {
                  console.warn(
                    "Ignoring GitHub webhook automation event without configured runtime",
                    {
                      deliveryId: meta.deliveryId,
                      event: meta.event,
                      installationId: meta.installationId,
                    },
                  );
                  return;
                }

                const { scope } = runtime.stored;
                await this.#runtimeServices.objects.automations
                  .for(scope)
                  .commands.ingestEvent(buildGitHubAutomationEvent({ scope, event, meta }));
              });

              register("installation.deleted", async ({ payload }, idempotencyKey) => {
                await this.#cleanupInstallationRouting(
                  `${payload.installation.id}`,
                  idempotencyKey,
                );
              });
            },
          },
          {
            ...implementation.fragmentDatabase,
          },
          new BackofficeKernel(runtime),
        ),
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async ensureAdminConfig() {
    if (!this.#configResolution.ok) {
      throw new Error(
        this.#configResolution.error ?? "GitHub is not configured for this environment.",
      );
    }

    const source = extractFragmentConfig(this.#configResolution.config);
    const existing = await this.#host.loadStored();
    // The object's own name says where it is kept.
    const scope = this.#scope;
    this.#host.assertSameScope(existing, scope);
    if (existing && configsEqual(existing.source, source)) {
      return;
    }

    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.storeAndInitialize({ scope, source });
    });
  }

  async #cleanupInstallationRouting(installationId: string, idempotencyKey: string) {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return;
    }

    const routerDo = this.#runtimeServices.objects.githubWebhookRouter.singleton();
    const cleanup = await routerDo.commands.clearInstallationRouting(normalizedInstallationId);
    console.info("Cleaned GitHub webhook router installation mapping after uninstall", {
      installationId: normalizedInstallationId,
      removedMapping: cleanup.removedMapping,
      clearedPendingWebhooks: cleanup.clearedPendingWebhooks,
      idempotencyKey,
    });
  }

  async alarm() {
    await this.#host.alarm();
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#host.getDurableHookQueue(({ runtime }) => runtime, options);
  }

  async getDurableHook(hookId: string) {
    return await this.#host.getDurableHook(({ runtime }) => runtime, hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async redeliverFailedInstallationWebhooks(installationId: string): Promise<void> {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      console.warn("GitHub install callback redelivery skipped", {
        reason: "Missing installation id.",
      });
      return;
    }
    const targetInstallationId = Number.parseInt(normalizedInstallationId, 10);
    if (!Number.isSafeInteger(targetInstallationId)) {
      console.warn("GitHub install callback redelivery skipped", {
        installationId: normalizedInstallationId,
        reason: "Invalid installation id.",
      });
      return;
    }

    const runtime = this.#host.getConfigured();
    if (!runtime) {
      console.warn("GitHub install callback redelivery skipped", {
        installationId: normalizedInstallationId,
        reason: "GitHub is not configured for this environment.",
      });
      return;
    }

    const app = getGitHubAppFromFragment(runtime.runtime);
    const deliveriesResponse = await app.octokit.request("GET /app/hook/deliveries", {
      per_page: 100,
    });
    const deliveries = deliveriesResponse.data;

    const isFailedDelivery = (delivery: (typeof deliveries)[number]) => {
      const status = delivery.status.trim().toUpperCase();

      if (status === "OK") {
        return false;
      }
      if (delivery.status_code >= 200 && delivery.status_code < 300) {
        return false;
      }
      if (status === "PENDING" || status === "IN_PROGRESS") {
        return false;
      }
      return true;
    };

    const failedInstallationDeliveries = deliveries.filter((delivery) => {
      const event = delivery.event.toLowerCase();
      if (event !== "installation") {
        return false;
      }
      if (!isFailedDelivery(delivery)) {
        return false;
      }
      return delivery.installation_id === targetInstallationId;
    });

    let redelivered = 0;
    let redeliveryFailures = 0;

    for (const delivery of failedInstallationDeliveries) {
      try {
        await app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
          delivery_id: delivery.id,
        });
        redelivered += 1;
      } catch (error) {
        redeliveryFailures += 1;
        console.warn("GitHub install callback failed to request webhook redelivery", {
          installationId: normalizedInstallationId,
          deliveryId: delivery.id,
          error,
        });
      }
    }
    console.info("GitHub install callback redelivery pass completed", {
      installationId: normalizedInstallationId,
      scannedDeliveries: deliveries.length,
      failedInstallationDeliveries: failedInstallationDeliveries.length,
      redelivered,
      redeliveryFailures,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const configured = this.#host.getConfigured();
    if (!configured) {
      const resolution = this.#configResolution;
      return Response.json(
        {
          message: "GitHub is not configured for this environment.",
          code: "NOT_CONFIGURED",
          missing: resolution.ok ? [] : resolution.missing,
          error: resolution.ok ? null : resolution.error,
        },
        { status: 400 },
      );
    }

    return await this.#httpTransport(request, (verifiedRequest, options) =>
      this.#host.fetch(verifiedRequest, options),
    );
  }
}
