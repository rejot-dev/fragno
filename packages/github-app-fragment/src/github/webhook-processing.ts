import type { HookContext } from "@fragno-dev/db";

import type { EmitterWebhookEvent } from "@octokit/webhooks";

import { githubAppSchema } from "../schema";
import { syncInstallationFromGitHub } from "./installation-sync";
import type { GitHubAppFragmentServices } from "./services";
import type {
  GitHubAppFragmentConfig,
  GitHubAppWebhookConfig,
  GitHubAppWebhookDelivery,
  GitHubAppWebhookMeta,
  GitHubAppWebhookOn,
} from "./types";

/** Names the stored delivery, whose body the hook reads when it runs. */
export type WebhookProcessingPayload = {
  deliveryId: string;
};

/** Events that change the installation or its repositories, which GitHub reports on request. */
const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

type InternalWebhookHandler = (
  event: EmitterWebhookEvent,
  idempotencyKey: string,
  meta: GitHubAppWebhookMeta,
) => void | Promise<void>;

const toEmitterWebhookEvent = (delivery: GitHubAppWebhookDelivery): EmitterWebhookEvent => {
  return {
    id: delivery.deliveryId,
    name: delivery.event as EmitterWebhookEvent["name"],
    payload: delivery.payload as EmitterWebhookEvent["payload"],
  } as EmitterWebhookEvent;
};

const createWebhookEventDispatcher = (configureOn?: GitHubAppWebhookConfig) => {
  const handlersByEvent = new Map<string, InternalWebhookHandler[]>();

  const registerOn: GitHubAppWebhookOn = (event, handler) => {
    const events = Array.isArray(event) ? event : [event];
    for (const eventName of events) {
      const handlers = handlersByEvent.get(eventName);
      if (handlers) {
        handlers.push(handler as InternalWebhookHandler);
      } else {
        handlersByEvent.set(eventName, [handler as InternalWebhookHandler]);
      }
    }
  };

  configureOn?.(registerOn);

  return async (event: EmitterWebhookEvent, idempotencyKey: string, meta: GitHubAppWebhookMeta) => {
    if (handlersByEvent.size === 0) {
      return;
    }

    const action =
      "action" in event.payload && typeof event.payload.action === "string"
        ? event.payload.action
        : null;
    const dispatchEvents = action
      ? [`${event.name}.${action}`, event.name, "*"]
      : [event.name, "*"];
    const handlers: InternalWebhookHandler[] = [];

    for (const eventName of dispatchEvents) {
      const registered = handlersByEvent.get(eventName);
      if (registered && registered.length > 0) {
        handlers.push(...registered);
      }
    }

    if (handlers.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(
      handlers.map(async (handler) => {
        await handler(event, idempotencyKey, meta);
      }),
    );
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result): unknown => result.reason);

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "One or more configured webhook handlers failed.");
    }
  };
};

export const createWebhookProcessor = (
  config: Pick<GitHubAppFragmentConfig, "webhook">,
  services: GitHubAppFragmentServices,
) => {
  const dispatchWebhookEvent = createWebhookEventDispatcher(config.webhook);

  return async function processWebhook(
    this: HookContext,
    { deliveryId }: WebhookProcessingPayload,
  ) {
    const row = await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(githubAppSchema).findFirst("webhook_delivery", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", deliveryId)),
        ),
      )
      .transformRetrieve(([row]) => row)
      .execute();
    // The hook completes in a later transaction than `processedAt`, so a lost completion replays
    // it. Cleanup deletes only processed deliveries, so a missing one was processed too.
    if (row?.processedAt !== null) {
      return;
    }
    const delivery = webhookDeliveryOfRow(row);

    const meta: GitHubAppWebhookMeta = {
      deliveryId,
      event: delivery.event,
      action: delivery.action,
      installationId: delivery.installationId,
      hookId: this.hookId.toString(),
      receivedAt: delivery.receivedAt,
    };
    // Deliveries arrive in any order, so they prompt a sync instead of applying their payload.
    if (INSTALLATION_EVENTS.has(delivery.event)) {
      const synced = await syncInstallationFromGitHub(
        this.handlerTx.bind(this),
        services,
        delivery.installationId,
        new Date(delivery.receivedAt),
      );
      // Throwing retries the delivery; a 404 already recorded the deletion.
      if (!synced.ok && synced.code === "GITHUB_API_ERROR") {
        throw new Error(synced.message);
      }
    }
    await dispatchWebhookEvent(toEmitterWebhookEvent(delivery), this.idempotencyKey, meta);
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        forSchema(githubAppSchema).update("webhook_delivery", deliveryId, (b) =>
          b.set({ processedAt: new Date() }),
        );
      })
      .execute();
  };
};

export function webhookDeliveryOfRow(row: {
  id: { toString(): string };
  event: string;
  action: string | null;
  installationId: string;
  receivedAt: Date;
  payload: Record<string, unknown>;
}): GitHubAppWebhookDelivery {
  return {
    deliveryId: row.id.toString(),
    event: row.event,
    action: row.action,
    installationId: row.installationId,
    receivedAt: row.receivedAt.toISOString(),
    payload: row.payload,
  };
}
