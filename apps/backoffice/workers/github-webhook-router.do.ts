import { DurableObject } from "cloudflare:workers";

import type { GitHubInstallationOwner } from "@/fragno/github";

import type {
  GitHubWebhookRouterObject,
  AdminConfigResponse,
  CreateInstallUrlResult,
  ResolveInstallStateInput,
  InstallStateResolutionResult,
  ConsumeInstallStateInput,
  ConsumeInstallStateResult,
  StoreInstallationClaimStateInput,
  InstallationClaimStateResolutionResult,
  StoreInstallationClaimCompletionInput,
  GitHubWebhookRouterSnapshot,
} from "./github-webhook-router-object";

export class GitHubWebhookRouter extends DurableObject<CloudflareEnv> {
  #object!: GitHubWebhookRouterObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { GitHubWebhookRouterObject } = await import("./github-webhook-router-object");
      const { createCloudflareDurableObjectRuntimeServices } =
        await import("@/backoffice-runtime/runtime-services");
      this.#object = new GitHubWebhookRouterObject({
        state,
        env,
        runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async getAdminConfig(orgId: string, origin: string): Promise<AdminConfigResponse> {
    return await this.#object.getAdminConfig(orgId, origin);
  }

  async isAppConfigured(): Promise<boolean> {
    return await this.#object.isAppConfigured();
  }

  async createInstallStatefulUrl(
    userId: string,
    owner: GitHubInstallationOwner,
  ): Promise<CreateInstallUrlResult> {
    return await this.#object.createInstallStatefulUrl(userId, owner);
  }

  async requestRepositoryInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    repositoryFullName: string,
  ): Promise<CreateInstallUrlResult> {
    return await this.#object.requestRepositoryInstall(userId, owner, repositoryFullName);
  }

  async getPendingInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    account: string,
  ): Promise<{ installUrl: string; repositories: string[] } | null> {
    return await this.#object.getPendingInstall(userId, owner, account);
  }

  async resolveInstallState(
    input: ResolveInstallStateInput,
  ): Promise<InstallStateResolutionResult> {
    return await this.#object.resolveInstallState(input);
  }

  async consumeInstallState(input: ConsumeInstallStateInput): Promise<ConsumeInstallStateResult> {
    return await this.#object.consumeInstallState(input);
  }

  async storeInstallationClaimState(
    input: StoreInstallationClaimStateInput,
  ): Promise<{ ok: true }> {
    return await this.#object.storeInstallationClaimState(input);
  }

  async resolveInstallationClaimState(
    input: ResolveInstallStateInput,
  ): Promise<InstallationClaimStateResolutionResult> {
    return await this.#object.resolveInstallationClaimState(input);
  }

  async storeInstallationClaimCompletion(
    input: StoreInstallationClaimCompletionInput,
  ): Promise<{ ok: true }> {
    return await this.#object.storeInstallationClaimCompletion(input);
  }

  async consumeInstallationClaimState(input: ResolveInstallStateInput): Promise<{ ok: true }> {
    return await this.#object.consumeInstallationClaimState(input);
  }

  async setInstallationOwner(
    installationId: string,
    owner: GitHubInstallationOwner,
  ): ReturnType<GitHubWebhookRouterObject["setInstallationOwner"]> {
    return await this.#object.setInstallationOwner(installationId, owner);
  }

  async getInstallationOwner(installationId: string): Promise<GitHubInstallationOwner | null> {
    return await this.#object.getInstallationOwner(installationId);
  }

  async clearInstallationRouting(installationId: string): Promise<{
    ok: true;
    removedMapping: boolean;
    clearedPendingWebhooks: number;
  }> {
    return await this.#object.clearInstallationRouting(installationId);
  }

  async getWebhookRouterSnapshot(): Promise<GitHubWebhookRouterSnapshot> {
    return await this.#object.getWebhookRouterSnapshot();
  }
}
