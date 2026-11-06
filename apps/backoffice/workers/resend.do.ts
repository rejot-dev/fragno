import type { BackofficeUserContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";

import type { InboundEmailCommands, ResendCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { ResendObject, ConfigResponse, ResendConfigScope } from "./resend-object";

export class Resend
  extends DurableObject<CloudflareEnv>
  implements ResendCommands, InboundEmailCommands
{
  #object!: ResendObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { ResendObject } = await import("./resend-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new ResendObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<ConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(
    payload: unknown,
    scope: ResendConfigScope,
    origin: string,
  ): Promise<ConfigResponse> {
    return await this.#object.setAdminConfig(payload, scope, origin);
  }

  async queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string; senderName: string | null },
  ): Promise<void> {
    await this.#object.queueEmail(input, options);
  }

  async checkWebhook() {
    return await this.#object.checkWebhook();
  }

  async getMailbox(owner: BackofficeUserContextScope) {
    return await this.#object.getMailbox(owner);
  }

  async openMailbox(owner: BackofficeUserContextScope, address: string) {
    return await this.#object.openMailbox(owner, address);
  }

  async pauseMailbox(owner: BackofficeUserContextScope) {
    return await this.#object.pauseMailbox(owner);
  }

  async replaceMailboxAddress(owner: BackofficeUserContextScope, address: string) {
    return await this.#object.replaceMailboxAddress(owner, address);
  }

  async getMailboxEmail(owner: BackofficeUserContextScope, emailMessageId: string) {
    return await this.#object.getMailboxEmail(owner, emailMessageId);
  }

  async getMailboxEmailAttachment(
    owner: BackofficeUserContextScope,
    emailMessageId: string,
    attachmentId: string,
  ) {
    return await this.#object.getMailboxEmailAttachment(owner, emailMessageId, attachmentId);
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await this.#object.getDurableHookQueue(options);
  }

  async getDurableHook(hookId: string) {
    return await this.#object.getDurableHook(hookId);
  }

  async wakeDurableHooks() {
    await this.#object.wakeDurableHooks();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
