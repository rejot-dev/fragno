import type { HookContext } from "@fragno-dev/db";

import type { EmitterWebhookEvent } from "@octokit/webhooks";

import { syncInstallationFromGitHub } from "./installation-sync";
import type { GitHubAppFragmentServices } from "./services";
import type {
  GitHubAppFragmentConfig,
  GitHubAppWebhookConfig,
  GitHubAppWebhookMeta,
  GitHubAppWebhookOn,
} from "./types";

export type WebhookProcessingPayload = {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: string;
  payload: Record<string, unknown>;
  receivedAt?: string | null;
};

/** Events that change the installation or its repositories, which GitHub reports on request. */
const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

type InternalWebhookHandler = (
  event: EmitterWebhookEvent,
  idempotencyKey: string,
  meta: GitHubAppWebhookMeta,
) => void | Promise<void>;

const toEmitterWebhookEvent = (data: WebhookProcessingPayload): EmitterWebhookEvent => {
  return {
    id: data.deliveryId,
    name: data.event as EmitterWebhookEvent["name"],
    payload: data.payload as EmitterWebhookEvent["payload"],
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

const resolveReceivedAt = (receivedAt?: string | null) => {
  if (!receivedAt) {
    return new Date();
  }
  const parsed = new Date(receivedAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

export const createWebhookProcessor = (
  config: Pick<GitHubAppFragmentConfig, "webhook">,
  services: GitHubAppFragmentServices,
) => {
  const dispatchWebhookEvent = createWebhookEventDispatcher(config.webhook);

  return async function processWebhook(this: HookContext, data: WebhookProcessingPayload) {
    const meta: GitHubAppWebhookMeta = {
      deliveryId: data.deliveryId,
      event: data.event,
      action: data.action,
      installationId: data.installationId,
      hookId: this.hookId.toString(),
      receivedAt: data.receivedAt ?? null,
    };
    // Deliveries arrive in any order, so they prompt a sync instead of applying their payload.
    if (INSTALLATION_EVENTS.has(data.event)) {
      const synced = await syncInstallationFromGitHub(
        this.handlerTx.bind(this),
        services,
        data.installationId,
        resolveReceivedAt(data.receivedAt),
      );
      // Throwing retries the delivery; a 404 already recorded the deletion.
      if (!synced.ok && synced.code === "GITHUB_API_ERROR") {
        throw new Error(synced.message);
      }
    }
    await dispatchWebhookEvent(toEmitterWebhookEvent(data), this.idempotencyKey, meta);
  };
};
