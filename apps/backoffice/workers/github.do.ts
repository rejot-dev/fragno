import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";

import {
  getGitHubAppFromFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";

import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import { createGitHubServer, type GitHubFragment } from "@/fragno/github";

import { extractFragmentConfig, resolveGitHubConfig } from "./github.shared";

const GITHUB_WEBHOOK_ROUTER_SINGLETON_ID = "GITHUB_WEBHOOK_ROUTER_SINGLETON_ID";

export class GitHub extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #host: FragmentDurableObjectHost<GitHubAppFragmentConfig, GitHubFragment>;
  #fragment: GitHubFragment | null = null;
  #configResolution: ReturnType<typeof resolveGitHubConfig>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#configResolution = resolveGitHubConfig(env);
    this.#host = createFragmentDurableObjectHost({
      name: "GitHub",
      state,
      env,
      createRuntime: (config) =>
        createGitHubServer(
          {
            ...config,
            webhook: (register) => {
              register("installation.deleted", async ({ payload }, idempotencyKey) => {
                await this.#cleanupInstallationRouting(
                  `${payload.installation.id}`,
                  idempotencyKey,
                );
              });
            },
          },
          state,
        ),
      onProcessError: (error) => {
        console.error("GitHub hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("GitHub hook processor disabled", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      if (!this.#configResolution.ok) {
        return;
      }

      this.#fragment = await this.#host.initialize(
        extractFragmentConfig(this.#configResolution.config),
      );
    });
  }

  async #cleanupInstallationRouting(installationId: string, idempotencyKey: string) {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return;
    }

    const routerDo = this.#env.GITHUB_WEBHOOK_ROUTER.get(
      this.#env.GITHUB_WEBHOOK_ROUTER.idFromName(GITHUB_WEBHOOK_ROUTER_SINGLETON_ID),
    );
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

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    if (!this.#fragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(this.#fragment, options);
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

    if (!this.#fragment) {
      console.warn("GitHub install callback redelivery skipped", {
        installationId: normalizedInstallationId,
        reason: "GitHub is not configured for this environment.",
      });
      return;
    }

    const app = getGitHubAppFromFragment(this.#fragment);
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
    if (!this.#fragment) {
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

    return await this.#host.fetch(this.#fragment, request);
  }
}
