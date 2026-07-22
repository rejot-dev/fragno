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
  BeforeCreateUserHook,
  VerifyUserEmailInput,
  VerifyUserEmailResult,
} from "@fragno-dev/auth";
import { migrate } from "@fragno-dev/db";

import type { AuthObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { createAuthServer, type AuthFragment } from "@/fragno/auth/auth";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import {
  AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
  AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
  AUTH_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/auth";
import { createDurableHookRepository } from "@/fragno/durable-hooks";
import { buildUserSignUpVerificationEmail } from "@/transactional-emails/user-sign-up";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

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
    : AUTOMATION_SYSTEM_ACTOR;

type AuthLiveEnv = Extract<Parameters<typeof createAuthServer>[0], { type: "live" }>["env"];

const dispatchOrganizationEvent = async (
  runtime: BackofficeRuntimeServices,
  eventType: AuthOrganizationAutomationEventType,
  payload: OrganizationHookPayload,
  hookId: string,
) => {
  const { organization } = payload;
  const occurredAt = toIsoString(
    eventType === AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED
      ? organization.createdAt
      : organization.updatedAt,
  );

  const event = {
    id: hookId,
    scope: { kind: "system" } as const,
    source: AUTH_AUTOMATION_SOURCE,
    eventType,
    occurredAt,
    payload: buildOrganizationPayload(organization),
    actor: buildAuthActor(payload.actor),
    actors: [buildAuthActor(payload.actor)],
    subject: { orgId: organization.id },
  };

  await runtime.objects.automations.singleton().ingestEvent(event);
};

const createDevRejotAdminHook = (): BeforeCreateUserHook | undefined => {
  if (import.meta.env.MODE !== "development") {
    return undefined;
  }

  return ({ email }) =>
    email.trim().toLowerCase().endsWith("@rejot.dev") ? { role: "admin" } : undefined;
};

const isDevelopmentAdminEmailVerificationExempt = (user: Pick<UserSummary, "role">): boolean =>
  import.meta.env.MODE === "development" && user.role === "admin";

const createOrganizationAutomationHooks = (
  runtime: BackofficeRuntimeServices,
): OrganizationHooks => ({
  onOrganizationCreated: async (payload, context) => {
    await dispatchOrganizationEvent(
      runtime,
      AUTH_AUTOMATION_EVENT_ORGANIZATION_CREATED,
      payload,
      context.hookId,
    );
  },
  onOrganizationUpdated: async (payload, context) => {
    await dispatchOrganizationEvent(
      runtime,
      AUTH_AUTOMATION_EVENT_ORGANIZATION_UPDATED,
      payload,
      context.hookId,
    );
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

const resolveTransactionalEmailPublicBaseUrl = (runtime: BackofficeRuntimeServices): string => {
  const configuredBaseUrl = runtime.config.docsPublicBaseUrl;
  if (!configuredBaseUrl) {
    throw new Error(
      "DOCS_PUBLIC_BASE_URL must be configured before sending transactional signup email.",
    );
  }

  let url: URL;
  try {
    url = new URL(configuredBaseUrl);
  } catch (cause) {
    throw new Error("DOCS_PUBLIC_BASE_URL must be an absolute http or https URL.", { cause });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DOCS_PUBLIC_BASE_URL must be an absolute http or https URL.");
  }

  return url.toString();
};

export class InMemoryAuthObject implements AuthObject {
  readonly #env: AuthLiveEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  #fragment: AuthFragment | null = null;
  #fragmentBaseUrl: string | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: AuthLiveEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtimeServices = runtime;

    const fragment = this.#createFragment();
    this.#fragment = fragment;

    void state.blockConcurrencyWhile(async () => {
      try {
        await migrate(fragment);
        this.#ensureDispatcher();
      } catch (error) {
        console.log("Migration failed", { error });
      }
    });
  }

  #createFragment(baseUrl?: string) {
    const runtime = this.#runtimeServices;

    return createAuthServer(
      {
        type: "live",
        env: this.#env,
        adapters: this.#runtimeServices.adapters,
      },
      {
        baseUrl,
        beforeCreateUser: createDevRejotAdminHook(),
        emailVerification: {
          required: runtime.config.transactionalEmails.enabled,
          isExempt: ({ user }) => isDevelopmentAdminEmailVerificationExempt(user),
        },
        authHooks: {
          onUserCreated: async function queueUserSignUpVerificationEmail(payload, context) {
            if (!runtime.config.transactionalEmails.enabled) {
              return;
            }

            if (payload.actor?.id !== payload.user.id || payload.emailVerifiedAt !== null) {
              return;
            }

            if (isDevelopmentAdminEmailVerificationExempt(payload.user)) {
              return;
            }

            const publicBaseUrl = resolveTransactionalEmailPublicBaseUrl(runtime);
            const verification = await runtime.objects.otp.singleton().issueEmailVerification({
              userId: payload.user.id,
              email: payload.user.email,
              publicBaseUrl,
              otpId: context.hookId,
            });

            await runtime.objects.resend.singleton().queueEmail(
              buildUserSignUpVerificationEmail({
                email: payload.user.email,
                verificationUrl: verification.url,
                expiresInHours: verification.expiresInHours,
              }),
              {
                idempotencyKey: `auth:user-created:${payload.user.id}:${context.idempotencyKey}`,
              },
            );
          },
        },
        organizationHooks: createOrganizationAutomationHooks(this.#runtimeServices),
      },
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
    return createDurableHookRepository(() => this.#ensureFragment());
  }

  async verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult> {
    const fragment = this.#ensureFragment();
    return await fragment.callServices(() => fragment.services.verifyUserEmail(input));
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

  async getDevOrganizations(): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      createdBy: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    const organizations = await this.getAllOrganizations();
    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdBy: organization.createdBy,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const fragment = this.#getFragment(request);
    return fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Auth extends DurableObject<CloudflareEnv> implements AuthObject {
  readonly #object: InMemoryAuthObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAuthObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult> {
    return await this.#object.verifyUserEmail(input);
  }

  async getAllOrganizations(): Promise<Organization[]> {
    return await this.#object.getAllOrganizations();
  }

  async getDevOrganizations(): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      createdBy: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return await this.#object.getDevOrganizations();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
