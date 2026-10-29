import { DurableObject } from "cloudflare:workers";

import type {
  BackofficeDeferredExecution,
  BackofficeRequestExecution,
} from "@/backoffice-runtime/context";
import type { OtpCommands } from "@/backoffice-runtime/object-registry";
import type {
  AccessCodeCheck,
  AccessCodePageInput,
  AccessCodePageResult,
  AccessCodeRecord,
  AccessCodeRedemptionsInput,
  AccessCodeRedemptionsResult,
  CreateAccessCodeInput,
  CreateAccessCodeResult,
  RedeemAccessCodeInput,
  RevokeAccessCodeInput,
} from "@/fragno/access-codes/contracts";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type {
  OtpObject,
  IssueEmailVerificationInput,
  IssueEmailVerificationResult,
  ConfirmEmailVerificationChallengeInput,
  ConfirmEmailVerificationChallengeResult,
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

  async createAccessCode(input: CreateAccessCodeInput): Promise<CreateAccessCodeResult> {
    return await this.#object.createAccessCode(input);
  }

  async listAccessCodes(input: AccessCodePageInput): Promise<AccessCodePageResult> {
    return await this.#object.listAccessCodes(input);
  }

  async revokeAccessCode(input: RevokeAccessCodeInput): Promise<AccessCodeRecord | null> {
    return await this.#object.revokeAccessCode(input);
  }

  async checkAccessCode(input: { code: string }): Promise<AccessCodeCheck> {
    return await this.#object.checkAccessCode(input);
  }

  async redeemAccessCode(input: RedeemAccessCodeInput): Promise<AccessCodeCheck> {
    return await this.#object.redeemAccessCode(input);
  }

  async listAccessCodeRedemptions(
    input: AccessCodeRedemptionsInput,
  ): Promise<AccessCodeRedemptionsResult> {
    return await this.#object.listAccessCodeRedemptions(input);
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

  async wakeDurableHooks() {
    await this.#object.wakeDurableHooks();
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
