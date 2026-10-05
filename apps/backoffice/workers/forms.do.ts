import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import { createBackofficeFragmentHttpTransport } from "@/backoffice-runtime/fragment-http-transport";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { FormsObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { createFormsServer, type FormsFragment } from "@/fragno/forms";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

const SYSTEM_SCOPE = { kind: "system" } as const;

export class InMemoryFormsObject extends RpcTarget implements FormsObject {
  readonly #host: FragmentDurableObjectHost<void, FormsFragment>;
  #fragment: FormsFragment | null = null;

  readonly #httpTransport: ReturnType<typeof createBackofficeFragmentHttpTransport>;

  constructor({
    state,
    env,
    nowEpochMs,
    runtime,
    implementation,
  }: {
    state: BackofficeObjectState;
    env: Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    this.#httpTransport = createBackofficeFragmentHttpTransport({
      address: { binding: "FORMS", scope: { kind: "singleton" } },
      env,
      nowEpochMs,
    });
    this.#host = implementation.createFragmentHost({
      name: "Forms",
      createRuntime: () =>
        createFormsServer(
          {
            onFormCreated: async function ingestFormCreatedEvent(payload, context) {
              await runtime.objects.automations.singleton().commands.ingestEvent(
                {
                  id: context.hookId.toString(),
                  scopeRestriction: null,
                  scope: SYSTEM_SCOPE,
                  source: "forms",
                  eventType: "form.created",
                  occurredAt: payload.createdAt,
                  payload: { form: payload },
                  actors: {
                    initiator: AUTOMATION_SYSTEM_INITIATOR,
                    principal: null,
                    delegation: [],
                  },
                  subject: { formId: payload.id },
                },
                { propagationContext: context.capturePropagationContext() },
              );
            },
            onFormUpdated: async function ingestFormUpdatedEvent(payload, context) {
              await runtime.objects.automations.singleton().commands.ingestEvent(
                {
                  id: context.hookId.toString(),
                  scopeRestriction: null,
                  scope: SYSTEM_SCOPE,
                  source: "forms",
                  eventType: "form.updated",
                  occurredAt: payload.updatedAt,
                  payload: { form: payload },
                  actors: {
                    initiator: AUTOMATION_SYSTEM_INITIATOR,
                    principal: null,
                    delegation: [],
                  },
                  subject: { formId: payload.id },
                },
                { propagationContext: context.capturePropagationContext() },
              );
            },
            onFormDeleted: async function ingestFormDeletedEvent(payload, context) {
              const { deletedAt, ...form } = payload;
              await runtime.objects.automations.singleton().commands.ingestEvent(
                {
                  id: context.hookId.toString(),
                  scopeRestriction: null,
                  scope: SYSTEM_SCOPE,
                  source: "forms",
                  eventType: "form.deleted",
                  occurredAt: deletedAt,
                  payload: { form },
                  actors: {
                    initiator: AUTOMATION_SYSTEM_INITIATOR,
                    principal: null,
                    delegation: [],
                  },
                  subject: { formId: payload.id },
                },
                { propagationContext: context.capturePropagationContext() },
              );
            },
            onResponseSubmitted: async function ingestFormResponseSubmittedEvent(payload, context) {
              await runtime.objects.automations.singleton().commands.ingestEvent(
                {
                  id: context.hookId.toString(),
                  scopeRestriction: null,
                  scope: SYSTEM_SCOPE,
                  source: "forms",
                  eventType: "response.submitted",
                  occurredAt: payload.submittedAt,
                  payload: { response: payload },
                  actors: {
                    initiator: AUTOMATION_SYSTEM_INITIATOR,
                    principal: null,
                    delegation: [],
                  },
                  subject: { formId: payload.formId, responseId: payload.id },
                },
                { propagationContext: context.capturePropagationContext() },
              );
            },
          },
          implementation.fragmentDatabase,
          new BackofficeKernel(runtime),
        ),
      onProcessError: (error) => {
        console.error("Forms hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Forms hook dispatcher initialization failed", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): FormsFragment {
    if (!this.#fragment) {
      throw new Error("Forms is unavailable.");
    }
    return this.#fragment;
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#httpTransport(request, (verifiedRequest, options) =>
      this.#host.fetch(this.#getFragment(), verifiedRequest, options),
    );
  }
}

export class Forms extends DurableObject<CloudflareEnv> implements FormsObject {
  readonly #object: InMemoryFormsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryFormsObject(createCloudflareBackofficeObjectContext(state, env));
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#object.getDurableHookQueue(options);
  }

  async getDurableHook(hookId: string) {
    return await this.#object.getDurableHook(hookId);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
