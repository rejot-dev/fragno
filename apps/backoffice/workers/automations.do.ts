import type {
  AutomationEvent,
  AutomationEventDefinitionUpdateInput,
} from "@fragno-dev/backoffice-api/v0/events";
import type {
  MarketplaceIngestionRequestInput,
  PackagesImportLegacyInput,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type {
  AutomationsCommands,
  BackofficeRpcContext,
  BackofficeActionRpcContext,
  AutomationsDurableHookFragment,
} from "@/backoffice-runtime/object-registry";
import type { AutomationEventSourceInput } from "@/fragno/automation/event-sources";
import type { EventDeletionPass } from "@/fragno/automation/events-storage-runtime";
import type {
  BindExternalIdentityInput,
  RevokeExternalIdentityInput,
  GetExternalIdentityBindingInput,
  ListExternalIdentityBindingsInput,
} from "@/fragno/automation/external-identities";
import type { PackageInstallationInput } from "@/fragno/automation/package-installations";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
import type { MarketplacePackagePublishRequest } from "@/fragno/marketplace/package-publishing";
import type { OnboardingAnswer } from "@/fragno/onboarding/contracts";

import type { AutomationsObject } from "./automations-object";
import type { SqlQuery } from "./lib/backoffice-object-implementation";
import { acceptsBrotli, compressStreamingResponse } from "./lib/flushing-brotli-response";

export class Automations extends DurableObject<CloudflareEnv> implements AutomationsCommands {
  #object!: AutomationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { AutomationsObject } = await import("./automations-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new AutomationsObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async triggerIngestEvent(event: AutomationEvent, context?: BackofficeRpcContext) {
    return await this.#object.triggerIngestEvent(event, context);
  }

  async ingestEvent(event: AutomationEvent, context?: BackofficeRpcContext) {
    return await this.#object.ingestEvent(event, context);
  }

  async getRouteForAuthority(input: { id: string }) {
    return await this.#object.getRouteForAuthority(input);
  }

  async seedStarterAutomationRoutes() {
    return await this.#object.seedStarterAutomationRoutes();
  }

  async startUserOnboarding(input: { userId: string }) {
    return await this.#object.startUserOnboarding(input);
  }

  async answerUserOnboarding(input: { userId: string; answer: OnboardingAnswer }) {
    await this.#object.answerUserOnboarding(input);
  }

  async requestMarketplacePackagePublish(
    request: MarketplacePackagePublishRequest,
    context: BackofficeActionRpcContext,
  ): Promise<boolean> {
    return await this.#object.requestMarketplacePackagePublish(request, context);
  }

  async requestStaticMarketplacePublications(input?: { force?: boolean }) {
    return await this.#object.requestStaticMarketplacePublications(input);
  }

  async requestMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.requestMarketplaceIngestion(input, context);
  }

  async restartMarketplaceIngestion(
    input: MarketplaceIngestionRequestInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.restartMarketplaceIngestion(input, context);
  }

  async bindExternalIdentity(
    input: BindExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.bindExternalIdentity(input, context);
  }

  async revokeExternalIdentity(
    input: RevokeExternalIdentityInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.revokeExternalIdentity(input, context);
  }

  async resolveExternalIdentity(
    input: GetExternalIdentityBindingInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.resolveExternalIdentity(input, context);
  }

  async listExternalIdentityBindings(
    input: ListExternalIdentityBindingsInput,
    context: BackofficeActionRpcContext,
  ) {
    return await this.#object.listExternalIdentityBindings(input, context);
  }

  async listEventsOfType(input: { source: string; eventType: string; cursor: string | null }) {
    return await this.#object.listEventsOfType(input);
  }

  async deleteEventsOfType(input: EventDeletionPass) {
    return await this.#object.deleteEventsOfType(input);
  }

  async listEventSources() {
    return await this.#object.listEventSources();
  }

  async getEventSource(input: { source: string }) {
    return await this.#object.getEventSource(input);
  }

  async ensureEventSource(input: AutomationEventSourceInput) {
    return await this.#object.ensureEventSource(input);
  }

  async listEventDefinitions() {
    return await this.#object.listEventDefinitions();
  }

  async getEventDefinition(input: { source: string; eventType: string }) {
    return await this.#object.getEventDefinition(input);
  }

  async updateEventDefinition(input: AutomationEventDefinitionUpdateInput) {
    return await this.#object.updateEventDefinition(input);
  }

  async resolveProjectForExecution(input: { projectId?: string; slug?: string }) {
    return await this.#object.resolveProjectForExecution(input);
  }

  async listPackageInstallations() {
    return await this.#object.listPackageInstallations();
  }

  async getPackageInstallation(input: { listingId: string }) {
    return await this.#object.getPackageInstallation(input);
  }

  async getPackageInstallationRecord(input: { listingId: string }) {
    return await this.#object.getPackageInstallationRecord(input);
  }

  async createFileShare(input: { shareId: string; path: string; target: BackofficeRoutableScope }) {
    return await this.#object.createFileShare(input);
  }

  async getFileShare(input: { shareId: string }) {
    return await this.#object.getFileShare(input);
  }

  async listFileShares() {
    return await this.#object.listFileShares();
  }

  async deleteFileShare(input: { shareId: string }) {
    return await this.#object.deleteFileShare(input);
  }

  async acceptFileShare(input: {
    shareId: string;
    name: string;
    source: BackofficeRoutableScope;
    path: string;
  }) {
    return await this.#object.acceptFileShare(input);
  }

  async getAcceptedFileShareByName(input: { name: string }) {
    return await this.#object.getAcceptedFileShareByName(input);
  }

  async listAcceptedFileShares() {
    return await this.#object.listAcceptedFileShares();
  }

  async deleteAcceptedFileShare(input: { shareId: string }) {
    return await this.#object.deleteAcceptedFileShare(input);
  }

  async applyPackageInstallation(input: PackageInstallationInput) {
    return await this.#object.applyPackageInstallation(input);
  }

  async uninstallPackage(input: { listingId: string }) {
    return await this.#object.uninstallPackage(input);
  }

  async importLegacyPackageInstallations(input: PackagesImportLegacyInput) {
    return await this.#object.importLegacyPackageInstallations(input);
  }

  async provisionAppProject(input: {
    appId: string;
    externalProjectId: string;
    name: string;
    createdByUserId: string;
  }) {
    return await this.#object.provisionAppProject(input);
  }

  async getDurableHookQueue(
    fragment: AutomationsDurableHookFragment,
    options?: DurableHookQueueOptions,
  ) {
    return await this.#object.getDurableHookQueue(fragment, options);
  }

  async getDurableHook(fragment: AutomationsDurableHookFragment, hookId: string) {
    return await this.#object.getDurableHook(fragment, hookId);
  }

  async wakeDurableHooks() {
    await this.#object.wakeDurableHooks();
  }

  async checkPageQueries(queries: SqlQuery[]) {
    return await this.#object.checkPageQueries(queries);
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.#object.fetch(request);
    // A first catch-up streams hundreds of megabytes, nearly all repeated GitHub payloads, from
    // this object through the web Worker to the edge. Compressing it here shrinks every hop.
    if (
      response.status !== 200 ||
      !new URL(request.url).pathname.endsWith("/_internal/outbox/stream") ||
      response.headers.has("content-encoding")
    ) {
      return response;
    }
    if (!acceptsBrotli(request)) {
      console.info("backoffice.outbox_stream.compression", {
        outcome: "uncompressed",
        acceptEncoding: request.headers.get("accept-encoding"),
      });
      return response;
    }
    return compressStreamingResponse(response, "backoffice.outbox_stream.compression");
  }
}
