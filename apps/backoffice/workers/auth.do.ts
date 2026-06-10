import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { DurableObject } from "cloudflare:workers";

import type {
  Organization,
  OrganizationHookPayload,
  OrganizationHooks,
  UserSummary,
} from "@fragno-dev/auth";
import { migrate } from "@fragno-dev/db";

import { createAuthServer, type AuthFragment } from "@/fragno/auth/auth";
import {
  AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
  AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  AUTH_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/auth";
import { createDurableHookRepository, type DurableHookQueueOptions } from "@/fragno/durable-hooks";

type AuthOrganizationAutomationEventType =
  | typeof AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED
  | typeof AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED;

const toIsoString = (date: Date | string): string =>
  date instanceof Date ? date.toISOString() : new Date(date).toISOString();

const buildOrganizationPayload = (organization: Organization) => ({
  organization: {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logoUrl: organization.logoUrl ?? null,
    metadata: organization.metadata ?? null,
    createdBy: organization.createdBy,
    createdAt: toIsoString(organization.createdAt),
    updatedAt: toIsoString(organization.updatedAt),
    deletedAt: organization.deletedAt ? toIsoString(organization.deletedAt) : null,
  },
});

const buildAuthActor = (actor: UserSummary | null) =>
  actor
    ? {
        scope: "internal" as const,
        type: "user" as const,
        id: actor.id,
        email: actor.email,
        role: actor.role,
      }
    : null;

const dispatchOrganizationEvent = async (
  env: CloudflareEnv,
  eventType: AuthOrganizationAutomationEventType,
  payload: OrganizationHookPayload,
) => {
  const { organization } = payload;
  const occurredAt = toIsoString(
    eventType === AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED
      ? organization.createdAt
      : organization.updatedAt,
  );

  await env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(organization.id)).ingestEvent({
    id: `${AUTH_AUTOMATION_SOURCE}:${eventType}:${organization.id}:${occurredAt}`,
    orgId: organization.id,
    source: AUTH_AUTOMATION_SOURCE,
    eventType,
    occurredAt,
    payload: buildOrganizationPayload(organization),
    actor: buildAuthActor(payload.actor),
    subject: { orgId: organization.id },
  });
};

const createOrganizationAutomationHooks = (env: CloudflareEnv): OrganizationHooks => ({
  onOrganizationCreated: async (payload) => {
    await dispatchOrganizationEvent(env, AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED, payload);
  },
  onOrganizationUpdated: async (payload) => {
    await dispatchOrganizationEvent(env, AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED, payload);
  },
});

const resolveAuthBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (forwardedProto === "http" || forwardedProto === "https") {
    requestUrl.protocol = `${forwardedProto}:`;
  }

  return requestUrl.origin;
};

export class Auth extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: AuthFragment | null = null;
  #fragmentBaseUrl: string | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;

    const fragment = this.#createFragment();
    this.#fragment = fragment;

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(fragment);
        this.#ensureDispatcher();
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  #createFragment(baseUrl?: string) {
    return createAuthServer(
      { type: "live", env: this.#env, state: this.#state },
      { baseUrl, organizationHooks: createOrganizationAutomationHooks(this.#env) },
    );
  }

  #ensureDispatcher() {
    if (!this.#fragment || this.#dispatcher) {
      return;
    }

    try {
      const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
        onProcessError: (error) => {
          console.error("Auth hook processor error", error);
        },
      });
      this.#dispatcher = dispatcherFactory(this.#state, this.#env);
    } catch (error) {
      console.warn("Auth hook processor disabled", error);
      this.#dispatcher = null;
    }
  }

  #ensureFragment() {
    if (!this.#fragment) {
      this.#fragment = this.#createFragment();
      this.#fragmentBaseUrl = null;
      this.#dispatcher = null;
    }

    this.#ensureDispatcher();

    return this.#fragment;
  }

  #getFragment(request: Request) {
    const baseUrl = resolveAuthBaseUrl(request);

    if (!this.#fragment || this.#fragmentBaseUrl !== baseUrl) {
      this.#fragment = this.#createFragment(baseUrl);
      this.#fragmentBaseUrl = baseUrl;
      this.#dispatcher = null;
    }

    return this.#ensureFragment();
  }

  async alarm() {
    if (this.#dispatcher?.alarm) {
      await this.#dispatcher.alarm();
    }
  }

  getDurableHookRepository() {
    return createDurableHookRepository<DurableHookQueueOptions>(() => this.#ensureFragment());
  }

  async getAllOrganizations(): Promise<Organization[]> {
    const fragment = this.#ensureFragment();
    return await fragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.getAllOrganizations()])
        .transform(({ serviceResult: [organizations] }) => organizations)
        .execute();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = this.#getFragment(request);
    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
