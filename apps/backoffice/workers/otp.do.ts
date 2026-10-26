import { DurableObject } from "cloudflare:workers";

import type {
  BackofficeDeferredExecution,
  BackofficeRequestExecution,
} from "@/backoffice-runtime/context";
import type { OtpCommands } from "@/backoffice-runtime/object-registry";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type {
  OtpObject,
  IssueEmailVerificationInput,
  IssueEmailVerificationResult,
  ConfirmEmailVerificationChallengeInput,
  ConfirmEmailVerificationChallengeResult,
  IssueSignUpInvitationInput,
  IssueSignUpInvitationResult,
  ConfirmSignUpInvitationInput,
  ConfirmSignUpInvitationResult,
  IssueIdentityClaimInput,
  IssueIdentityClaimResult,
  ConfirmIdentityClaimInput,
  ConfirmIdentityClaimResult,
} from "./otp-object";

export class Otp extends DurableObject<CloudflareEnv> implements OtpCommands {
  #object!: OtpObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { OtpObject } = await import("./otp-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new OtpObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async issueEmailVerification(
    input: IssueEmailVerificationInput,
  ): Promise<IssueEmailVerificationResult> {
    return await this.#object.issueEmailVerification(input);
  }

  async confirmEmailVerificationChallenge(
    input: ConfirmEmailVerificationChallengeInput,
  ): Promise<ConfirmEmailVerificationChallengeResult> {
    return await this.#object.confirmEmailVerificationChallenge(input);
  }

  async issueSignUpInvitation(
    input: IssueSignUpInvitationInput,
  ): Promise<IssueSignUpInvitationResult> {
    return await this.#object.issueSignUpInvitation(input);
  }

  async confirmSignUpInvitation(
    input: ConfirmSignUpInvitationInput,
  ): Promise<ConfirmSignUpInvitationResult> {
    return await this.#object.confirmSignUpInvitation(input);
  }

  async issueIdentityClaim(
    input: IssueIdentityClaimInput,
    execution: BackofficeDeferredExecution,
  ): Promise<IssueIdentityClaimResult> {
    return await this.#object.issueIdentityClaim(input, execution);
  }

  async getIdentityClaim(input: ConfirmIdentityClaimInput) {
    return await this.#object.getIdentityClaim(input);
  }

  async confirmIdentityClaim(
    input: ConfirmIdentityClaimInput,
    execution: BackofficeRequestExecution,
  ): Promise<ConfirmIdentityClaimResult> {
    return await this.#object.confirmIdentityClaim(input, execution);
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
