import type {
  OrganizationMembershipRecord,
  OrganizationInvitationRecord,
  OrganizationRole,
} from "@fragno-dev/backoffice-api/v0/organization";
import type {
  ProvisionOrganizationInput,
  ProvisionOrganizationResult,
  ProvisionOrganizationForInviteeInput,
  ProvisionOrganizationForInviteeResult,
  AcceptInvitationInput,
  CreateInvitationInput,
  ListManagedOrganizationsInput,
  ProvisionManagedOrganizationInput,
  ProvisionManagedOrganizationResult,
} from "@fragno-dev/backoffice-api/v0/provisioning";
import type { DirectoryPageInput } from "@fragno-dev/backoffice-api/v0/shared/pagination";
import type { BackofficeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type { AuthCommands, ScenarioAuthFixture } from "@/backoffice-runtime/object-registry";
import type { BackofficeRootOwnerReference } from "@/backoffice-runtime/resolved-scope";
import type { AppInstallationOwner } from "@/fragno/app-installations/contracts";
import type {
  ProvisioningApp,
  AppProvisioningResult,
  AppInvitation,
} from "@/fragno/auth/app-provisioning";
import type {
  OrganizationAccess,
  OrganizationHookPayload,
  VerifyUserEmailInput,
  VerifyUserEmailResult,
  BackofficeMeData,
  BackofficeCliOAuthConfig,
  UserOrganizationAuthorityInput,
} from "@/fragno/auth/contracts";
import type {
  BackofficeExecutionTokenExchangeInput,
  BackofficeExecutionTokenResult,
} from "@/fragno/auth/execution-token";
import type {
  BackofficeOAuthClientCreateRequest,
  BackofficeOAuthClientCreateResult,
  BackofficeOAuthClientListInput,
  BackofficeOAuthClientPage,
  BackofficeOAuthClientUpdateInput,
  BackofficeOAuthClientRotateSecretInput,
} from "@/fragno/auth/oauth-client";
import type { AppActionTokenInput } from "@/fragno/auth/token-lifecycle";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { AuthObject } from "./auth-object";

export class Auth extends DurableObject<CloudflareEnv> implements AuthCommands {
  #object!: AuthObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { AuthObject } = await import("./auth-object");
      const { createCloudflareDurableObjectRuntimeServices } =
        await import("@/backoffice-runtime/runtime-services");
      this.#object = new AuthObject({
        state,
        env,
        runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      });
    });
  }

  async alarm() {
    await this.#object.alarm();
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

  async enqueueEmailVerificationHook(
    input: { userId: string; email: string },
    propagationContext?: Readonly<Record<string, string>> | null,
  ) {
    return await this.#object.enqueueEmailVerificationHook(input, propagationContext);
  }

  async enqueueOrganizationHook(
    hookName: "onOrganizationCreated" | "onOrganizationUpdated",
    payload: OrganizationHookPayload,
    propagationContext?: Readonly<Record<string, string>> | null,
  ) {
    return await this.#object.enqueueOrganizationHook(hookName, payload, propagationContext);
  }

  async verifyUserEmail(input: VerifyUserEmailInput): Promise<VerifyUserEmailResult> {
    return await this.#object.verifyUserEmail(input);
  }

  async getBackofficeMe(input: {
    userId: string;
    activeOrganizationId: string | null;
  }): Promise<BackofficeMeData | null> {
    return await this.#object.getBackofficeMe(input);
  }

  async createAdminOAuthClient(
    input: BackofficeOAuthClientCreateRequest & { administratorUserId: string },
  ): Promise<BackofficeOAuthClientCreateResult> {
    return await this.#object.createAdminOAuthClient(input);
  }

  async listAdminOAuthClients(
    input: BackofficeOAuthClientListInput & { administratorUserId: string },
  ): Promise<BackofficeOAuthClientPage> {
    return await this.#object.listAdminOAuthClients(input);
  }

  async updateAdminOAuthClient(
    input: BackofficeOAuthClientUpdateInput & { administratorUserId: string },
  ) {
    return await this.#object.updateAdminOAuthClient(input);
  }

  async rotateAdminOAuthClientSecret(
    input: BackofficeOAuthClientRotateSecretInput & { administratorUserId: string },
  ) {
    return await this.#object.rotateAdminOAuthClientSecret(input);
  }

  async getOAuthClientFacts(input: { clientId: string }) {
    return await this.#object.getOAuthClientFacts(input);
  }

  async issueAppInstallationCode(input: {
    appId: string;
    owner: AppInstallationOwner;
    activation: number;
  }) {
    return await this.#object.issueAppInstallationCode(input);
  }

  async issueAppActionToken(input: AppActionTokenInput): Promise<{ token: string }> {
    return await this.#object.issueAppActionToken(input);
  }

  async getBackofficeCliOAuthConfig(input: {
    requestUrl: string;
  }): Promise<BackofficeCliOAuthConfig> {
    return await this.#object.getBackofficeCliOAuthConfig(input);
  }

  async exchangeBackofficeExecutionToken(
    input: BackofficeExecutionTokenExchangeInput,
  ): Promise<BackofficeExecutionTokenResult> {
    return await this.#object.exchangeBackofficeExecutionToken(input);
  }

  async authenticateInstalledAppClient(input: { requestUrl: string; oauthAccessToken: string }) {
    return await this.#object.authenticateInstalledAppClient(input);
  }

  async getUserAuthorityFacts(input: { userId: string; organizationId?: string }) {
    return await this.#object.getUserAuthorityFacts(input);
  }

  async findAdministeredMember(input: { administratorId: string; memberId: string }) {
    return await this.#object.findAdministeredMember(input);
  }

  async findRootOwnerScope(owner: BackofficeRootOwnerReference) {
    return await this.#object.findRootOwnerScope(owner);
  }

  async getUserOrganizationAuthorityFacts(input: UserOrganizationAuthorityInput) {
    return await this.#object.getUserOrganizationAuthorityFacts(input);
  }

  async grantBackofficeAdminByEmail(input: { email: string }) {
    return await this.#object.grantBackofficeAdminByEmail(input);
  }

  async createAdminOrganization(input: { name: string; slug: string; ownerEmail: string }) {
    return await this.#object.createAdminOrganization(input);
  }

  async createUserOrganization(input: { id: string; userId: string; name: string }) {
    return await this.#object.createUserOrganization(input);
  }

  async createManagedOrganization(input: {
    id: string;
    userId: string;
    managingOrganizationId: string;
    name: string;
  }) {
    return await this.#object.createManagedOrganization(input);
  }

  async chooseUserJurisdiction(input: {
    userId: string;
    jurisdiction: BackofficeJurisdiction | null;
  }) {
    await this.#object.chooseUserJurisdiction(input);
  }

  async finishUserOnboarding(input: { userId: string }) {
    await this.#object.finishUserOnboarding(input);
  }

  async provisionAppOrganization(
    input: ProvisioningApp & ProvisionOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationResult>> {
    return await this.#object.provisionAppOrganization(input);
  }

  async provisionAppOrganizationForInvitee(
    input: ProvisioningApp & ProvisionOrganizationForInviteeInput,
  ): Promise<AppProvisioningResult<ProvisionOrganizationForInviteeResult>> {
    return await this.#object.provisionAppOrganizationForInvitee(input);
  }

  async provisionAppManagedOrganization(
    input: ProvisioningApp & ProvisionManagedOrganizationInput,
  ): Promise<AppProvisioningResult<ProvisionManagedOrganizationResult>> {
    return await this.#object.provisionAppManagedOrganization(input);
  }

  async listManagedOrganizations(input: ListManagedOrganizationsInput) {
    return await this.#object.listManagedOrganizations(input);
  }

  async confirmAppOrganizationActor(input: {
    oauthClientId: string;
    organizationId: string;
    userId: string;
  }): Promise<AppProvisioningResult<OrganizationAccess>> {
    return await this.#object.confirmAppOrganizationActor(input);
  }

  async findInvitation(input: { invitationId: string }): Promise<AppInvitation | null> {
    return await this.#object.findInvitation(input);
  }

  async acceptAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & AcceptInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationMembershipRecord>> {
    return await this.#object.acceptAppInvitation(input);
  }

  async createAppInvitation(
    input: Pick<ProvisioningApp, "oauthClientId"> & CreateInvitationInput,
  ): Promise<AppProvisioningResult<OrganizationInvitationRecord>> {
    return await this.#object.createAppInvitation(input);
  }

  async verifyAdminUserEmail(input: { email: string }) {
    return await this.#object.verifyAdminUserEmail(input);
  }

  async addAdminOrganizationMember(input: {
    organizationId: string;
    userEmail: string;
    roles: readonly OrganizationRole[];
  }) {
    return await this.#object.addAdminOrganizationMember(input);
  }

  async removeAdminOrganizationMember(input: { organizationId: string; userEmail: string }) {
    return await this.#object.removeAdminOrganizationMember(input);
  }

  async getAccountProfile(input: { userId: string }) {
    return await this.#object.getAccountProfile(input);
  }

  async updateAccountProfile(input: { userId: string; name: string }) {
    return await this.#object.updateAccountProfile(input);
  }

  async listAccountOrganizations(input: { userId: string }) {
    return await this.#object.listAccountOrganizations(input);
  }

  async listAccountInvitations(input: { userId: string }) {
    return await this.#object.listAccountInvitations(input);
  }

  async acceptAccountInvitation(input: { userId: string; invitationId: string }) {
    return await this.#object.acceptAccountInvitation(input);
  }

  async listAccountOAuthConsents(input: { userId: string } & DirectoryPageInput) {
    return await this.#object.listAccountOAuthConsents(input);
  }

  async getOrganization(input: { organizationId: string }) {
    return await this.#object.getOrganization(input);
  }

  async getOrganizationMembership(input: { organizationId: string; userId: string }) {
    return await this.#object.getOrganizationMembership(input);
  }

  async getOrganizationAccess(input: { organizationId: string; userId: string }) {
    return await this.#object.getOrganizationAccess(input);
  }

  async updateOrganization(input: { organizationId: string; name: string }) {
    return await this.#object.updateOrganization(input);
  }

  async setOrganizationManager(input: {
    organizationId: string;
    managingOrganizationId: string | null;
  }) {
    return await this.#object.setOrganizationManager(input);
  }

  async getOrganizationRelations(input: { organizationId: string }) {
    return await this.#object.getOrganizationRelations(input);
  }

  async listOrganizations(input: DirectoryPageInput) {
    return await this.#object.listOrganizations(input);
  }

  async listOrganizationMembers(input: { organizationId: string } & DirectoryPageInput) {
    return await this.#object.listOrganizationMembers(input);
  }

  async listOrganizationMembersByPage(input: {
    organizationId: string;
    page: number;
    pageSize: number;
  }) {
    return await this.#object.listOrganizationMembersByPage(input);
  }

  async listOrganizationInvitations(input: { organizationId: string } & DirectoryPageInput) {
    return await this.#object.listOrganizationInvitations(input);
  }

  async createOrganizationInvitation(input: {
    organizationId: string;
    inviterUserId: string;
    email: string;
    roles: readonly OrganizationRole[];
  }) {
    return await this.#object.createOrganizationInvitation(input);
  }

  async getAllOrganizations() {
    return await this.#object.getAllOrganizations();
  }

  async getOrganizationBySlug(slug: string) {
    return await this.#object.getOrganizationBySlug(slug);
  }

  async hasOrganizationMember(input: { organizationId: string; userId: string }) {
    return await this.#object.hasOrganizationMember(input);
  }

  async getDevOrganizations() {
    return await this.#object.getDevOrganizations();
  }

  async applyScenarioFixture(fixture: ScenarioAuthFixture) {
    await this.#object.applyScenarioFixture(fixture);
  }

  async getScenarioMemberRoles(input: { organizationId: string; userId: string }) {
    return await this.#object.getScenarioMemberRoles(input);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
