import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { FormsObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { createFormsServer, type FormsFragment } from "@/fragno/forms";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";

const SYSTEM_SCOPE = { kind: "system" } as const;

export class InMemoryFormsObject extends RpcTarget implements FormsObject {
  readonly #host: FragmentDurableObjectHost<void, FormsFragment>;
  #fragment: FormsFragment | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    this.#host = createFragmentDurableObjectHost({
      name: "Forms",
      state,
      env,
      createRuntime: () =>
        createFormsServer(
          {
            onFormCreated: async function ingestFormCreatedEvent(payload, context) {
              await runtime.objects.automations.singleton().commands.ingestEvent(
                {
                  id: context.hookId.toString(),
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
          { adapters: runtime.adapters },
        ),
      durableHooksInstrumentation: cloudflareDurableHooksInstrumentation,
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
    return await this.#host.fetch(this.#getFragment(), request);
  }
}

export class Forms extends DurableObject<CloudflareEnv> implements FormsObject {
  readonly #object: InMemoryFormsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryFormsObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
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
