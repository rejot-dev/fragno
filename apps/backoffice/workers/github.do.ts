import { DurableObject } from "cloudflare:workers";

import {
  getGitHubAppFromFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { GitHubObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { type DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  buildGitHubAutomationEvent,
  createGitHubServer,
  type GitHubFragment,
} from "@/fragno/github";

import { configsEqual, extractFragmentConfig, resolveGitHubConfig } from "./github.shared";
import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type StoredGitHubConfig = {
  scope: Extract<BackofficeContextScope, { kind: "org" }>;
  source: GitHubAppFragmentConfig;
};

export class InMemoryGitHubObject implements GitHubObject {
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<
    StoredGitHubConfig,
    GitHubAppFragmentConfig,
    GitHubFragment
  >;
  readonly #configResolution: ReturnType<typeof resolveGitHubConfig>;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: Parameters<typeof resolveGitHubConfig>[0];
    runtime: BackofficeRuntimeServices;
  }) {
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#configResolution = resolveGitHubConfig(env);
    this.#host = createBackofficeFragmentDurableObject({
      name: "GitHub",
      state,
      env,
      toSource: (stored) => stored.source,
      fingerprint: (source) => JSON.stringify(source),
      createRuntime: (config) =>
        createGitHubServer(
          {
            ...config,
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
                  .ingestEvent(buildGitHubAutomationEvent({ orgId: scope.orgId, event, meta }));
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
            adapters: this.#runtimeServices.adapters,
          },
        ),
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async ensureAdminConfig(orgId: string) {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      throw new Error("GitHub configuration requires an organisation id.");
    }
    if (!this.#configResolution.ok) {
      throw new Error(
        this.#configResolution.error ?? "GitHub is not configured for this environment.",
      );
    }

    const source = extractFragmentConfig(this.#configResolution.config);
    const existing = await this.#host.loadStored();
    const scope = { kind: "org" as const, orgId: normalizedOrgId };
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
    const cleanup = await routerDo.clearInstallationRouting(normalizedInstallationId);
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

  getDurableHookRepository() {
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => runtime);
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

    return await this.#host.fetch(request);
  }
}

export class GitHub extends DurableObject<CloudflareEnv> implements GitHubObject {
  readonly #object: InMemoryGitHubObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryGitHubObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async ensureAdminConfig(orgId: string) {
    return await this.#object.ensureAdminConfig(orgId);
  }

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async redeliverFailedInstallationWebhooks(installationId: string): Promise<void> {
    await this.#object.redeliverFailedInstallationWebhooks(installationId);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
