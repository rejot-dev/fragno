import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
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

import { configsEqual, extractFragmentConfig, resolveGitHubConfig } from "./github.shared";

const GITHUB_WEBHOOK_ROUTER_SINGLETON_ID = "GITHUB_WEBHOOK_ROUTER_SINGLETON_ID";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

export class GitHub extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: GitHubFragment | null = null;
  #fragmentConfig: GitHubAppFragmentConfig | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
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

  async #ensureFragment() {
    const resolution = resolveGitHubConfig(this.#env);
    if (!resolution.ok) {
      return null;
    }

    const config = extractFragmentConfig(resolution.config);

    if (!this.#fragment || !this.#fragmentConfig || !configsEqual(this.#fragmentConfig, config)) {
      this.#fragment = createGitHubServer(
        {
          ...config,
          webhook: (register) => {
            register("installation.deleted", async ({ payload }, idempotencyKey) => {
              await this.#cleanupInstallationRouting(`${payload.installation.id}`, idempotencyKey);
            });
          },
        },
        this.#state,
      );
      this.#fragmentConfig = config;
      this.#migrated = false;
      this.#dispatcher = null;
    }

    if (!this.#migrated && this.#fragment) {
      await migrate(this.#fragment);
      this.#migrated = true;
    }

    if (this.#fragment && !this.#dispatcher) {
      try {
        const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
          onProcessError: (error) => {
            console.error("GitHub hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("GitHub hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return this.#fragment;
  }

  async alarm() {
    const fragment = await this.#ensureFragment();
    const dispatcher = this.#dispatcher;
    if (!fragment || !dispatcher?.alarm) {
      return;
    }

    await dispatcher.alarm();
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(fragment, options);
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

    const fragment = await this.#ensureFragment();
    if (!fragment) {
      console.warn("GitHub install callback redelivery skipped", {
        installationId: normalizedInstallationId,
        reason: "GitHub is not configured for this environment.",
      });
      return;
    }

    const app = getGitHubAppFromFragment(fragment);
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
    const fragment = await this.#ensureFragment();
    if (!fragment) {
      const resolution = resolveGitHubConfig(this.#env);
      return jsonResponse(
        {
          message: "GitHub is not configured for this environment.",
          code: "NOT_CONFIGURED",
          missing: resolution.ok ? [] : resolution.missing,
          error: resolution.ok ? null : resolution.error,
        },
        400,
      );
    }

    return fragment.handler(request);
  }
}
