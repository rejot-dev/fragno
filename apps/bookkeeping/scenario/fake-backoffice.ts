import { createHash } from "node:crypto";

import {
  BACKOFFICE_API_ERROR_STATUS,
  type BackofficeApiErrorCode,
} from "@fragno-dev/backoffice-api/errors";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import {
  APP_ACTION_TOKEN_LIFETIME_SECONDS,
  appActionBodySha256,
  BACKOFFICE_TOKEN_ISSUER,
  type AppActionTokenClaims,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import type {
  OrganizationAccessRecord,
  OrganizationMembershipRecord,
} from "@fragno-dev/backoffice-api/v0/organization";
import type { PiAgentDefinitionCreate, PiPromptStatus } from "@fragno-dev/backoffice-api/v0/pi";
import { backofficeProvisioningOperations } from "@fragno-dev/backoffice-api/v0/provisioning";
import {
  backofficeContextScopeSchema,
  backofficeScopePathSegment,
  isBackofficeRoutableScope,
  parseBackofficeScopePathSegment,
  type BackofficeContextScope,
  type BackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";

/**
 * The key Backoffice signs action requests with, one for the whole test run as a deployment has
 * one: Bookkeeping's verifier caches signing keys for as long as its isolate lives.
 */
const ACTION_SIGNING_KEY_ID = "scenario-action-key";
const actionSigningKey = generateKeyPair("ES256");

type Role = "owner" | "admin" | "member";
type User = { id: string; email: string; name: string };
type Organization = {
  id: string;
  externalId: string;
  name: string;
  slug: string;
  createdAt: string;
  members: Map<string, { roles: Role[]; joinedAt: string }>;
  /** The organization whose members act in this one, as a firm does in its clients. */
  managingOrganizationId: string | null;
  installation: "active" | "uninstalled";
  /** Projects Bookkeeping provisioned, by its identifier for them. */
  projects: Map<string, { id: string; slug: string; name: string }>;
};
type Invitation = {
  id: string;
  organizationId: string;
  inviterId: string;
  email: string;
  roles: Role[];
  status: "pending" | "accepted";
  expiresAt: string;
  createdAt: string;
};
/** A prompt an agent received, and how far the agent got with it. */
type Prompt = {
  scope: string;
  agentName: string;
  requestId: string;
  content: string;
  /** Whether it runs in a subagent of the agent, beside its other work. */
  subagent: boolean;
  prompter: Principal;
  status: PiPromptStatus;
};
type Share = {
  shareId: string;
  from: BackofficeRoutableScope;
  path: string;
  with: BackofficeRoutableScope;
  sharedAt: string;
};
type AcceptedShare = {
  shareId: string;
  name: string;
  from: BackofficeRoutableScope;
  /** The accepting scope's workspace key. */
  scope: string;
  acceptedAt: string;
};
/** Who a credential acts as: a user who authorized Bookkeeping, or Bookkeeping itself. */
type Principal = { kind: "user"; userId: string } | { kind: "app" };

class ApiError extends Error {
  readonly code: BackofficeApiErrorCode;

  constructor(code: BackofficeApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

const MANAGING_ROLES = new Set<Role>(["owner", "admin"]);

/** Backoffice's workspace keeps each file in one Durable Object SQLite row. */
const WORKSPACE_FILE_MAX_BYTES = 1_900_000;

/**
 * Backoffice as Bookkeeping sees it over HTTP: OAuth sign-in, the credential exchange, the v0
 * operations Bookkeeping calls, and provisioning. Inputs and outputs go through
 * `@fragno-dev/backoffice-api`'s schemas, so the fake cannot drift from the published contract.
 * Scenarios change what only Backoffice's own UI could, such as removing a member.
 */
export class FakeBackoffice {
  readonly origin: string;
  readonly client = { id: "bookkeeping", secret: "bookkeeping-secret" };
  readonly #redirectUri: string;
  readonly #bookkeepingOrigin: string;
  /** Invitation emails Backoffice sent in Bookkeeping's name. */
  readonly sentInvitations: { to: string; url: string }[] = [];
  #emailConfigured = true;
  readonly #users = new Map<string, User>();
  readonly #organizations = new Map<string, Organization>();
  readonly #invitations = new Map<string, Invitation>();
  /** Users who authorized Bookkeeping; first-party apps are authorized without asking. */
  readonly #consents = new Set<string>();
  readonly #codes = new Map<string, { userId: string; challenge: string }>();
  readonly #accessTokens = new Map<string, Principal>();
  readonly #refreshTokens = new Map<string, string>();
  readonly #executionTokens = new Map<
    string,
    { principal: Principal; scope: BackofficeContextScope; organizationId: string }
  >();
  /** Workspace files by scope and path, e.g. those Bookkeeping stores in a project. */
  readonly #files = new Map<string, Uint8Array>();
  /** Agents defined in each workspace, by scope and name. */
  readonly #agents = new Map<string, PiAgentDefinitionCreate>();
  /** Prompts agents received, in the order they arrived. */
  readonly #prompts: Prompt[] = [];
  /** Folders one scope shares with another, by share ID; revoking the share deletes it. */
  readonly #shares = new Map<string, Share>();
  /** Shares scopes accepted, by the accepting scope and the name they mount the share under. */
  readonly #acceptedShares = new Map<string, AcceptedShare>();
  #reachable = true;
  /** Provisioning operations whose next response is lost after Backoffice did the work. */
  readonly #failNextResponse = new Set<string>();
  /** Operations whose next request is lost before it reaches Backoffice. */
  readonly #failNextRequest = new Set<string>();
  /** What happens elsewhere while Backoffice works on the next request for an operation. */
  readonly #beforeNextAnswer = new Map<string, () => Promise<void>>();

  constructor({ origin, bookkeepingOrigin }: { origin: string; bookkeepingOrigin: string }) {
    this.origin = origin;
    this.#bookkeepingOrigin = bookkeepingOrigin;
    this.#redirectUri = `${bookkeepingOrigin}/api/auth/callback/backoffice`;
  }

  /**
   * The person at Backoffice's sign-in page enters `email` and the code emailed to them, which
   * creates their account the first time, and returns to Bookkeeping. Returns Bookkeeping's
   * callback URL.
   */
  completeSignIn(authorizationUrl: string, email: string): string {
    const url = new URL(authorizationUrl);
    assertEqual(url.origin + url.pathname, `${this.origin}/api/auth/oauth2/authorize`);
    assertEqual(url.searchParams.get("client_id"), this.client.id);
    assertEqual(url.searchParams.get("redirect_uri"), this.#redirectUri);
    assertEqual(url.searchParams.get("code_challenge_method"), "S256");
    const user = this.#userByEmail(email) ?? this.#createUser(email);
    this.#consents.add(user.id);
    const code = randomToken();
    this.#codes.set(code, { userId: user.id, challenge: url.searchParams.get("code_challenge")! });
    const callback = new URL(this.#redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    return callback.toString();
  }

  /** Someone who already has a Backoffice account, e.g. one they signed up for in Backoffice. */
  addUser(user: { email: string; name: string }): void {
    const created = { id: crypto.randomUUID(), ...user };
    this.#users.set(created.id, created);
  }

  userId(email: string): string {
    const user = this.#userByEmail(email);
    if (!user) {
      throw new Error(`Backoffice has no user ${email}.`);
    }
    return user.id;
  }

  /** The organization Backoffice holds for one of Bookkeeping's workspaces. */
  organization(slug: string): {
    id: string;
    name: string;
    members: Map<string, Role[]>;
    projects: string[];
  } {
    const organization = this.#organizationBySlug(slug);
    return {
      id: organization.id,
      name: organization.name,
      projects: [...organization.projects.values()].map(({ name }) => name),
      members: new Map(
        [...organization.members].map(([userId, { roles }]) => [
          this.#users.get(userId)!.email,
          roles,
        ]),
      ),
    };
  }

  /** The person withdraws Bookkeeping's authorization in Backoffice; their tokens stop working. */
  revokeAuthorization(email: string): void {
    const userId = this.userId(email);
    this.#consents.delete(userId);
    for (const [token, principal] of this.#accessTokens) {
      if (principal.kind === "user" && principal.userId === userId) {
        this.#accessTokens.delete(token);
      }
    }
    for (const [token, owner] of this.#refreshTokens) {
      if (owner === userId) {
        this.#refreshTokens.delete(token);
      }
    }
  }

  /** A Backoffice without email delivery, as a local one usually is, fails to send emails. */
  setEmailConfigured(configured: boolean): void {
    this.#emailConfigured = configured;
  }

  /** While Backoffice is unreachable, every request fails as a network failure does. */
  setReachable(reachable: boolean): void {
    this.#reachable = reachable;
  }

  /** Backoffice does the next `operationId` it is asked to, but Bookkeeping never hears the answer. */
  failNextResponse(operationId: string): void {
    this.#failNextResponse.add(operationId);
  }

  /** The next request for `operationId` fails as a network failure does, before Backoffice sees it. */
  failNextRequest(operationId: string): void {
    this.#failNextRequest.add(operationId);
  }

  /**
   * `happen` runs while Backoffice works on the next request for `operationId`, before it answers,
   * e.g. an agent answering while Bookkeeping asks how far it got.
   */
  beforeNextAnswer(operationId: string, happen: () => Promise<void>): void {
    this.#beforeNextAnswer.set(operationId, happen);
  }

  /** The agents defined in the workspace of one of the organization's projects. */
  agents(slug: string, project: string): PiAgentDefinitionCreate[] {
    const prefix = this.#projectFileKey(slug, project, "");
    return [...this.#agents].flatMap(([key, agent]) => (key.startsWith(prefix) ? [agent] : []));
  }

  /** The prompts the agents of one of the organization's projects received, oldest first. */
  prompts(
    slug: string,
    project: string,
  ): {
    agentName: string;
    requestId: string;
    content: string;
    subagent: boolean;
    /** The email of the user who prompted, or `installation` for Bookkeeping itself. */
    prompter: string;
    status: string;
  }[] {
    const scope = this.#projectFileKey(slug, project, "");
    return this.#prompts
      .filter((prompt) => prompt.scope === scope)
      .map((prompt) => ({
        agentName: prompt.agentName,
        requestId: prompt.requestId,
        content: prompt.content,
        subagent: prompt.subagent,
        prompter:
          prompt.prompter.kind === "user"
            ? this.#users.get(prompt.prompter.userId)!.email
            : "installation",
        status: prompt.status.status,
      }));
  }

  /** The agent gets as far as `status` with the prompt submitted as `requestId`. */
  settlePrompt(
    requestId: string,
    status:
      | { status: "running" }
      | { status: "completed"; answer: string | null }
      | { status: "failed"; reason: string },
  ): void {
    const prompt = this.#prompts.find((candidate) => candidate.requestId === requestId);
    if (!prompt) {
      throw new Error(`No agent received prompt ${requestId}.`);
    }
    prompt.status = { requestId, ...status };
  }

  /**
   * The shares one of the organization's projects mounts and may read, by name, with the folder
   * each opens: those it accepted whose sharing scope has not revoked them.
   */
  mountedShares(slug: string, project: string): { name: string; path: string }[] {
    const scope = this.#projectFileKey(slug, project, "");
    return [...this.#acceptedShares.values()].flatMap((accepted) => {
      const share = this.#shares.get(accepted.shareId);
      return accepted.scope === scope && share ? [{ name: accepted.name, path: share.path }] : [];
    });
  }

  /** The folders one of the organization's projects shares and has not revoked. */
  standingShares(slug: string, project: string): string[] {
    const scope = this.#projectFileKey(slug, project, "");
    return [...this.#shares.values()].flatMap((share) =>
      `${backofficeScopePathSegment(share.from)} ` === scope ? [share.path] : [],
    );
  }

  organizationCount(): number {
    return this.#organizations.size;
  }

  /** The organization's pending invitations, with who sent them. */
  pendingInvitations(slug: string): { email: string; roles: Role[]; inviter: string }[] {
    return this.#pendingInvitations(this.#organizationBySlug(slug)).map((invitation) => ({
      email: invitation.email,
      roles: invitation.roles,
      inviter: this.#users.get(invitation.inviterId)!.email,
    }));
  }

  /** The file at `path` in the workspace of one of the organization's projects, if any. */
  workspaceFile(slug: string, project: string, path: string): Uint8Array | undefined {
    return this.#files.get(this.#projectFileKey(slug, project, path));
  }

  /** The paths of every file in the workspace of one of the organization's projects. */
  workspacePaths(slug: string, project: string): string[] {
    const prefix = this.#projectFileKey(slug, project, "");
    return [...this.#files.keys()].flatMap((key) =>
      key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
    );
  }

  /** An owner changes things in Backoffice's own UI. */
  readonly admin = {
    /** Someone replaces a file in a project's workspace, or deletes it with null. */
    replaceWorkspaceFile: (
      slug: string,
      project: string,
      path: string,
      bytes: Uint8Array | null,
    ) => {
      const key = this.#projectFileKey(slug, project, path);
      if (bytes === null) {
        this.#files.delete(key);
      } else {
        this.#files.set(key, bytes);
      }
    },
    /**
     * A global administrator creates an organization owned by these people and installs Bookkeeping
     * there, as `backoffice:connect` does for the operators. Returns its ID.
     */
    createOrganization: (name: string, ownerEmails: string[]): string => {
      const now = new Date().toISOString();
      const slug = nextSlug(
        name,
        [...this.#organizations.values()].map(({ slug }) => slug),
      );
      const organization: Organization = {
        id: crypto.randomUUID(),
        externalId: `admin:${slug}`,
        name,
        slug,
        createdAt: now,
        members: new Map(
          ownerEmails.map((email) => [this.userId(email), { roles: ["owner"], joinedAt: now }]),
        ),
        managingOrganizationId: null,
        installation: "active",
        projects: new Map(),
      };
      this.#organizations.set(organization.id, organization);
      return organization.id;
    },
    addMember: (slug: string, email: string, roles: Role[]) => {
      this.#organizationBySlug(slug).members.set(this.userId(email), {
        roles,
        joinedAt: new Date().toISOString(),
      });
    },
    removeMember: (slug: string, email: string) => {
      this.#organizationBySlug(slug).members.delete(this.userId(email));
    },
    setRoles: (slug: string, email: string, roles: Role[]) => {
      this.#organizationBySlug(slug).members.get(this.userId(email))!.roles = roles;
    },
    rename: (slug: string, name: string) => {
      this.#organizationBySlug(slug).name = name;
    },
    uninstall: (slug: string) => {
      this.#organizationBySlug(slug).installation = "uninstalled";
    },
    /** A project made in Backoffice itself, which Bookkeeping did not provision. */
    createProject: (slug: string, name: string) => {
      const organization = this.#organizationBySlug(slug);
      const project = { id: crypto.randomUUID(), slug: slugify(name), name };
      organization.projects.set(`backoffice:${project.id}`, project);
    },
  };

  /**
   * Backoffice calls Bookkeeping's action endpoint at `endpointUrl` with `body`, as
   * `integrations.execute` does: for a member's agent, or for an automation as the installation,
   * in one of the organization's projects or, with `project` null, in the organization. Returns
   * the signed request.
   */
  async actionRequest(input: {
    endpointUrl: string;
    actor: { email: string } | "installation";
    organization: string;
    project: string | null;
    body: unknown;
  }): Promise<Request> {
    const organization = this.#organizationBySlug(input.organization);
    const actor: AppActionTokenClaims["actor"] =
      input.actor === "installation"
        ? { kind: "installation" }
        : { kind: "user", userId: this.userId(input.actor.email) };
    if (actor.kind === "user" && !this.#access(organization, actor.userId)) {
      throw new Error(`Backoffice runs no actions for an outsider in ${organization.slug}.`);
    }
    const orgScope = { kind: "org" as const, orgId: organization.id, jurisdiction: null };
    let scopeRestriction: AppActionTokenClaims["scopeRestriction"] = orgScope;
    if (input.project !== null) {
      const project = [...organization.projects.values()].find(
        ({ name }) => name === input.project,
      );
      if (!project) {
        throw new Error(`${organization.slug} has no project ${input.project}.`);
      }
      scopeRestriction = { kind: "project", owner: orgScope, projectId: project.id };
    }
    const body = JSON.stringify(input.body);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      actor,
      installation: {
        appId: this.client.id,
        activation: 1,
        externalAccount: { id: organization.externalId, label: organization.name },
      },
      scopeRestriction,
      bodySha256: await appActionBodySha256(body),
    } satisfies Omit<AppActionTokenClaims, "iss" | "aud" | "iat" | "exp" | "jti" | "sub">)
      .setProtectedHeader({ alg: "ES256", kid: ACTION_SIGNING_KEY_ID })
      .setIssuer(BACKOFFICE_TOKEN_ISSUER)
      .setAudience(input.endpointUrl)
      .setSubject(actor.kind === "user" ? actor.userId : `app:${this.client.id}`)
      .setJti(randomToken())
      .setIssuedAt(now)
      .setExpirationTime(now + APP_ACTION_TOKEN_LIFETIME_SECONDS)
      .sign((await actionSigningKey).privateKey);
    return new Request(input.endpointUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#reachable) {
      throw new TypeError("fetch failed");
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/auth/oauth2/token") {
        return await this.#token(request);
      }
      if (url.pathname === "/api/auth/oauth2/userinfo") {
        return this.#userInfo(request);
      }
      if (url.pathname === "/api/auth/jwks") {
        const publicJwk = await exportJWK((await actionSigningKey).publicKey);
        return Response.json({
          keys: [{ ...publicJwk, kid: ACTION_SIGNING_KEY_ID, alg: "ES256", use: "sig" }],
        });
      }
      if (url.pathname === "/api/backoffice/execution-token") {
        return await this.#executionToken(request);
      }
      const provisioning = /^\/api\/v0\/provisioning\/([^/]+)$/u.exec(url.pathname);
      if (provisioning) {
        const response = await this.#provision(request, provisioning[1]);
        if (this.#failNextResponse.delete(provisioning[1])) {
          throw new TypeError("fetch failed");
        }
        return response;
      }
      const operation = /^\/api\/v0\/scopes\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
      if (operation) {
        if (this.#failNextRequest.delete(operation[2])) {
          throw new TypeError("fetch failed");
        }
        const happen = this.#beforeNextAnswer.get(operation[2]);
        this.#beforeNextAnswer.delete(operation[2]);
        await happen?.();
        return await this.#operate(request, operation[1], operation[2]);
      }
      throw new ApiError("not_found", `Backoffice does not serve ${url.pathname}.`);
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: BACKOFFICE_API_ERROR_STATUS[error.code] },
        );
      }
      throw error;
    }
  }

  async #token(request: Request): Promise<Response> {
    const basic = /^Basic (.+)$/u.exec(request.headers.get("authorization") ?? "");
    const [clientId, clientSecret] = atob(basic?.[1] ?? "").split(":");
    if (clientId !== this.client.id || clientSecret !== this.client.secret) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const form = new URLSearchParams(await request.text());
    switch (form.get("grant_type")) {
      case "authorization_code": {
        const code = this.#codes.get(form.get("code") ?? "");
        this.#codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          !code ||
          base64url(createHash("sha256").update(verifier).digest()) !== code.challenge ||
          form.get("redirect_uri") !== this.#redirectUri
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return this.#issueUserTokens(code.userId);
      }
      case "refresh_token": {
        const userId = this.#refreshTokens.get(form.get("refresh_token") ?? "");
        if (!userId || !this.#consents.has(userId)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return this.#issueUserTokens(userId);
      }
      case "client_credentials": {
        const accessToken = randomToken();
        this.#accessTokens.set(accessToken, { kind: "app" });
        return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
      }
      case null:
      default:
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
  }

  #issueUserTokens(userId: string): Response {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.#accessTokens.set(accessToken, { kind: "user", userId });
    this.#refreshTokens.set(refreshToken, userId);
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access backoffice",
    });
  }

  #userInfo(request: Request): Response {
    const principal = this.#accessTokens.get(bearer(request));
    if (principal?.kind !== "user") {
      return new Response(null, { status: 401 });
    }
    const user = this.#users.get(principal.userId)!;
    return Response.json({
      sub: user.id,
      name: user.name,
      email: user.email,
      email_verified: true,
      picture: null,
    });
  }

  /**
   * An app credential for one organization, as Backoffice issues it: Bookkeeping must be
   * installed there, and a user's credential needs the user to act there now, as a member or a
   * member of the organization managing it.
   */
  async #executionToken(request: Request): Promise<Response> {
    const principal = this.#accessTokens.get(bearer(request));
    if (!principal) {
      throw new ApiError("authentication_failed", "A valid OAuth bearer token is required.");
    }
    const { scope } = z.object({ scope: backofficeContextScopeSchema }).parse(await request.json());
    const organizationId =
      scope.kind === "org"
        ? scope.orgId
        : scope.kind === "project" && scope.owner.kind === "org"
          ? scope.owner.orgId
          : null;
    if (organizationId === null) {
      return scopeUnavailable("Bookkeeping only works in organizations and their projects.");
    }
    const organization = this.#organizations.get(organizationId);
    if (organization?.installation !== "active") {
      return scopeUnavailable("This app is not installed by the requested scope's owner.");
    }
    if (
      scope.kind === "project" &&
      ![...organization.projects.values()].some(({ id }) => id === scope.projectId)
    ) {
      return scopeUnavailable("The organization has no such project.");
    }
    if (principal.kind === "user" && !this.#access(organization, principal.userId)) {
      return scopeUnavailable("You are not a member of this organization or of its manager.");
    }
    const accessToken = randomToken();
    this.#executionTokens.set(accessToken, { principal, scope, organizationId: organization.id });
    return Response.json({
      accessToken,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      scope,
    });
  }

  async #operate(request: Request, scopeSegment: string, operationId: string): Promise<Response> {
    const credential = this.#executionTokens.get(bearer(request));
    if (!credential) {
      throw new ApiError("authentication_failed", "The execution credential is invalid.");
    }
    const scope = parseBackofficeScopePathSegment(scopeSegment);
    if (backofficeScopePathSegment(scope) !== backofficeScopePathSegment(credential.scope)) {
      throw new ApiError("forbidden", "The credential is bound to another scope.");
    }
    const organization = this.#organizations.get(credential.organizationId)!;
    if (organization.installation !== "active") {
      throw new ApiError("authentication_failed", "The installation is no longer active.");
    }
    const { principal } = credential;
    const member = principal.kind === "user" ? this.#access(organization, principal.userId) : null;
    const body = request.headers.get("content-type") ? await request.json() : undefined;
    // The installation works in the projects it was installed for, as a member does.
    if (scope.kind === "project" && (member || principal.kind === "app")) {
      return this.#operateInWorkspace(scope, operationId, body, principal);
    }
    // Organization operations act as a user; Backoffice offers them only to a user's credential.
    if (!member) {
      throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
    switch (operationId) {
      case "org.get":
        return respond("org.get", undefined, () => this.#accessRecord(organization, member));
      case "org.invitations.list":
        return respond("org.invitations.list", body, () => ({
          invitations: this.#pendingInvitations(organization).map((invitation) => ({
            invitationId: invitation.id,
            organizationId: invitation.organizationId,
            email: invitation.email,
            roles: invitation.roles,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
            url: `${this.origin}/invitations/${invitation.id}`,
          })),
          nextCursor: null,
          hasNextPage: false,
        }));
      case "org.members.list":
        return respond("org.members.list", body, () => ({
          members: [...organization.members].map(([memberId, { roles, joinedAt }]) => {
            const user = this.#users.get(memberId)!;
            return { userId: user.id, name: user.name, email: user.email, roles, joinedAt };
          }),
          nextCursor: null,
          hasNextPage: false,
        }));
      default:
        throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
  }

  /** The workspace operations Bookkeeping calls in a project, as the person or as itself. */
  #operateInWorkspace(
    scope: BackofficeContextScope,
    operationId: string,
    body: unknown,
    principal: Principal,
  ): Response {
    const key = (path: string) => `${backofficeScopePathSegment(scope)} ${path}`;
    switch (operationId) {
      case "pi.agent.create":
        return respond("pi.agent.create", body, (definition) => {
          if (this.#agents.has(key(definition.agentName))) {
            throw new ApiError("conflict", `Pi agent '${definition.agentName}' already exists.`);
          }
          this.#agents.set(key(definition.agentName), definition);
          return {
            ...definition,
            steward: { kind: "members" },
            resolvedModel: "openai/gpt-6-luna",
          };
        });
      case "pi.prompt.submit":
        return respond("pi.prompt.submit", body, ({ agentName, requestId, content, subagent }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          const id = requestId ?? crypto.randomUUID();
          // A request ID is queued once.
          if (!this.#prompts.some((prompt) => prompt.requestId === id)) {
            this.#prompts.push({
              scope: key(""),
              agentName,
              requestId: id,
              content,
              subagent: subagent ?? false,
              prompter: principal,
              status: { requestId: id, status: "queued" },
            });
          }
          return { requestId: id, status: "queued" as const };
        });
      case "pi.prompt.get":
        return respond(
          "pi.prompt.get",
          body,
          ({ agentName, requestId }) =>
            this.#prompts.find(
              (prompt) =>
                prompt.scope === key("") &&
                prompt.agentName === agentName &&
                prompt.requestId === requestId,
            )?.status ?? null,
        );
      case "state.share":
        return respond("state.share", body, (input) => {
          if (!isBackofficeRoutableScope(scope)) {
            throw new ApiError("not_found", "Only workspaces share folders.");
          }
          const target = backofficeScopePathSegment(input.with);
          const exists = [...this.#organizations.values()].some((organization) =>
            [...organization.projects.values()].some(
              ({ id }) =>
                target ===
                backofficeScopePathSegment({
                  kind: "project",
                  owner: { kind: "org", orgId: organization.id, jurisdiction: null },
                  projectId: id,
                }),
            ),
          );
          if (!exists) {
            throw new ApiError("not_found", "The named scope does not exist.");
          }
          const share: Share = {
            shareId: crypto.randomUUID(),
            from: scope,
            path: input.path.endsWith("/") ? input.path : `${input.path}/`,
            with: input.with,
            sharedAt: new Date().toISOString(),
          };
          this.#shares.set(share.shareId, share);
          return this.#fileShare(share);
        });
      case "state.acceptShare":
        return respond("state.acceptShare", body, ({ from, shareId, name = shareId }) => {
          const share = this.#shares.get(shareId);
          if (
            !share ||
            backofficeScopePathSegment(share.from) !== backofficeScopePathSegment(from) ||
            backofficeScopePathSegment(share.with) !== backofficeScopePathSegment(scope)
          ) {
            throw new ApiError(
              "not_found",
              `That scope shares nothing with this one as ${shareId}.`,
            );
          }
          const accepted = [...this.#acceptedShares.values()].find(
            (candidate) => candidate.scope === key("") && candidate.shareId === shareId,
          );
          if (accepted) {
            return this.#acceptedFileShare(accepted);
          }
          if (this.#acceptedShares.has(key(name))) {
            throw new ApiError("conflict", `This scope already mounts another share as ${name}.`);
          }
          const record = {
            shareId,
            name,
            from: share.from,
            scope: key(""),
            acceptedAt: new Date().toISOString(),
          };
          this.#acceptedShares.set(key(name), record);
          return this.#acceptedFileShare(record);
        });
      case "state.listShares":
        return respond("state.listShares", body, () => ({
          shared: [...this.#shares.values()]
            .filter((share) => key("") === `${backofficeScopePathSegment(share.from)} `)
            .map((share) => this.#fileShare(share)),
          accepted: [...this.#acceptedShares.values()]
            .filter((accepted) => accepted.scope === key(""))
            .map((accepted) => this.#acceptedFileShare(accepted)),
        }));
      case "state.revokeShare":
        return respond("state.revokeShare", body, ({ shareId }) => {
          const share = this.#shares.get(shareId);
          const shared = share && key("") === `${backofficeScopePathSegment(share.from)} `;
          const accepted = [...this.#acceptedShares].find(
            ([, candidate]) => candidate.scope === key("") && candidate.shareId === shareId,
          );
          if (!shared && !accepted) {
            throw new ApiError("not_found", `This scope has no share ${shareId}.`);
          }
          if (shared) {
            this.#shares.delete(shareId);
          }
          if (accepted) {
            this.#acceptedShares.delete(accepted[0]);
          }
        });
      case "state.writeFileBytes":
        return respond("state.writeFileBytes", body, ({ path, content }) => {
          const bytes = new Uint8Array(Buffer.from(content, "base64"));
          if (bytes.byteLength > WORKSPACE_FILE_MAX_BYTES) {
            throw new ApiError("invalid_request", "The file is too large to store.");
          }
          this.#files.set(key(path), bytes);
        });
      case "state.readFileBytes":
        return respond("state.readFileBytes", body, ({ path }) => {
          const bytes = this.#files.get(key(path));
          if (!bytes) {
            throw new ApiError("not_found", `ENOENT: read '${path}'`);
          }
          return Buffer.from(bytes).toString("base64");
        });
      default:
        throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
  }

  #fileShare(share: Share) {
    return { shareId: share.shareId, path: share.path, with: share.with, sharedAt: share.sharedAt };
  }

  /** What the accepting scope sees of a share; one revoked since still shows until it revokes it. */
  #acceptedFileShare(accepted: AcceptedShare) {
    const share = this.#shares.get(accepted.shareId);
    return {
      shareId: accepted.shareId,
      name: accepted.name,
      from: accepted.from,
      path: `/shared/${accepted.name}/`,
      sourcePath: share?.path ?? "",
      acceptedAt: accepted.acceptedAt,
    };
  }

  #projectFileKey(slug: string, project: string, path: string): string {
    const organization = this.#organizationBySlug(slug);
    const found = [...organization.projects.values()].find(({ name }) => name === project);
    if (!found) {
      throw new Error(`${slug} has no project ${project}.`);
    }
    const scope: BackofficeContextScope = {
      kind: "project",
      owner: { kind: "org", orgId: organization.id, jurisdiction: null },
      projectId: found.id,
    };
    return `${backofficeScopePathSegment(scope)} ${path}`;
  }

  async #provision(request: Request, operationId: string): Promise<Response> {
    if (this.#accessTokens.get(bearer(request))?.kind !== "app") {
      throw new ApiError(
        "authentication_failed",
        "The app's client-credentials token is required.",
      );
    }
    const body: unknown = await request.json();
    switch (operationId) {
      case "organizations.provision": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        if (!this.#consents.has(input.ownerUserId)) {
          throw new ApiError(
            "forbidden",
            `User '${input.ownerUserId}' has not authorized this app.`,
          );
        }
        const existing = [...this.#organizations.values()].find(
          (org) => org.externalId === input.externalOrganizationId,
        );
        if (existing) {
          return Response.json(
            backofficeProvisioningOperations[operationId].output.parse({
              organizationId: existing.id,
              slug: existing.slug,
              jurisdiction: null,
              created: false,
            }),
          );
        }
        const now = new Date().toISOString();
        const organization: Organization = {
          id: crypto.randomUUID(),
          externalId: input.externalOrganizationId,
          name: input.name,
          slug: nextSlug(
            input.name,
            [...this.#organizations.values()].map(({ slug }) => slug),
          ),
          createdAt: now,
          members: new Map([[input.ownerUserId, { roles: ["owner"], joinedAt: now }]]),
          managingOrganizationId: null,
          installation: "active",
          projects: new Map(),
        };
        this.#organizations.set(organization.id, organization);
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizationId: organization.id,
            slug: organization.slug,
            jurisdiction: null,
            created: true,
          }),
        );
      }
      case "organizations.provisionForInvitee": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        if (!this.#consents.has(input.invitedByUserId)) {
          throw new ApiError(
            "forbidden",
            `User '${input.invitedByUserId}' has not authorized this app.`,
          );
        }
        const existing = [...this.#organizations.values()].find(
          (org) => org.externalId === input.externalOrganizationId,
        );
        const now = new Date().toISOString();
        const organization: Organization = existing ?? {
          id: crypto.randomUUID(),
          externalId: input.externalOrganizationId,
          name: input.name,
          slug: nextSlug(
            input.name,
            [...this.#organizations.values()].map(({ slug }) => slug),
          ),
          createdAt: now,
          // The inviting user does not become a member.
          members: new Map(),
          managingOrganizationId: null,
          installation: "active",
          projects: new Map(),
        };
        this.#organizations.set(organization.id, organization);
        const hasOwner = [...organization.members.values()].some(({ roles }) =>
          roles.includes("owner"),
        );
        let ownerInvitation: Invitation | null = null;
        if (!hasOwner) {
          const pending = this.#pendingInvitations(organization).find(({ roles }) =>
            roles.includes("owner"),
          );
          if (pending && pending.email !== input.ownerEmail) {
            throw new ApiError("conflict", "The owner invitation is pending for another address.");
          }
          ownerInvitation = pending ?? {
            id: randomToken(),
            organizationId: organization.id,
            inviterId: input.invitedByUserId,
            email: input.ownerEmail,
            roles: ["owner"],
            status: "pending",
            expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
            createdAt: now,
          };
          this.#invitations.set(ownerInvitation.id, ownerInvitation);
        }
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizationId: organization.id,
            slug: organization.slug,
            jurisdiction: null,
            created: existing === undefined,
            ownerInvitation: ownerInvitation && {
              invitationId: ownerInvitation.id,
              expiresAt: ownerInvitation.expiresAt,
            },
          }),
        );
      }
      case "organizations.provisionManaged": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const managing = this.#organizations.get(input.managingOrganizationId);
        if (managing?.installation !== "active") {
          throw new ApiError(
            "not_found",
            "This app is not installed in the managing organization.",
          );
        }
        if (
          !this.#consents.has(input.byUserId) ||
          !managing.members.get(input.byUserId)?.roles.some((role) => MANAGING_ROLES.has(role))
        ) {
          throw new ApiError(
            "forbidden",
            `User '${input.byUserId}' does not own or administer the managing organization.`,
          );
        }
        const existing = [...this.#organizations.values()].find(
          (org) => org.externalId === input.externalOrganizationId,
        );
        if (existing && existing.managingOrganizationId !== managing.id) {
          throw new ApiError("conflict", "The organization exists, managed by another or none.");
        }
        const now = new Date().toISOString();
        const organization: Organization = existing ?? {
          id: crypto.randomUUID(),
          externalId: input.externalOrganizationId,
          name: input.name,
          slug: nextSlug(
            input.name,
            [...this.#organizations.values()].map(({ slug }) => slug),
          ),
          createdAt: now,
          // The managing organization's owner or admin who asked does not become a member.
          members: new Map(),
          managingOrganizationId: managing.id,
          installation: "active",
          projects: new Map(),
        };
        this.#organizations.set(organization.id, organization);
        if (input.owner.kind === "invitee") {
          throw new Error(
            "The fake provisions managed organizations without an owner, as Bookkeeping does.",
          );
        }
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizationId: organization.id,
            slug: organization.slug,
            jurisdiction: null,
            created: existing === undefined,
            ownerInvitation: null,
          }),
        );
      }
      case "projects.provision": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const organization = this.#organizations.get(input.organizationId);
        if (organization?.installation !== "active") {
          throw new ApiError("not_found", "This app is not installed in the organization.");
        }
        if (
          !this.#access(organization, input.createdByUserId) ||
          !this.#consents.has(input.createdByUserId)
        ) {
          throw new ApiError(
            "forbidden",
            `User '${input.createdByUserId}' does not act in the organization or has not authorized this app.`,
          );
        }
        const existing = organization.projects.get(input.externalProjectId);
        const project = existing ?? {
          id: crypto.randomUUID(),
          slug: nextSlug(
            input.name,
            [...organization.projects.values()].map(({ slug }) => slug),
          ),
          name: input.name,
        };
        organization.projects.set(input.externalProjectId, project);
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizationId: organization.id,
            projectId: project.id,
            slug: project.slug,
            created: existing === undefined,
          }),
        );
      }
      case "invitations.create": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const organization = this.#organizations.get(input.organizationId);
        if (organization?.installation !== "active") {
          throw new ApiError("not_found", "This app is not installed in the organization.");
        }
        const inviter = this.#access(organization, input.inviterUserId);
        if (!inviter || !this.#consents.has(input.inviterUserId)) {
          throw new ApiError(
            "forbidden",
            `User '${input.inviterUserId}' does not act in the organization or has not authorized this app.`,
          );
        }
        if (!inviter.roles.some((role) => MANAGING_ROLES.has(role))) {
          throw new ApiError("forbidden", "Only owners and admins invite.");
        }
        // Management never confers owner, so a manager invites one only while there is none.
        const ownerless =
          inviter.through === "managing-organization" &&
          ![...organization.members.values()].some(({ roles }) => roles.includes("owner"));
        if (input.roles.includes("owner") && !inviter.roles.includes("owner") && !ownerless) {
          throw new ApiError("forbidden", "Only owners invite owners.");
        }
        const invitee = this.#userByEmail(input.email);
        if (invitee && organization.members.has(invitee.id)) {
          throw new ApiError("conflict", "User is already a member of this organization.");
        }
        const pending = this.#pendingInvitations(organization).find(
          (invitation) => invitation.email === input.email,
        );
        if (pending && [...pending.roles].sort().join() !== [...input.roles].sort().join()) {
          throw new ApiError("conflict", `'${input.email}' is already invited with other roles.`);
        }
        const invitation: Invitation = pending ?? {
          id: randomToken(),
          organizationId: organization.id,
          inviterId: input.inviterUserId,
          email: input.email,
          roles: input.roles,
          status: "pending",
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        };
        this.#invitations.set(invitation.id, invitation);
        const { id, status: _status, inviterId: _inviterId, ...record } = invitation;
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            invitationId: id,
            ...record,
          }),
        );
      }
      case "invitations.send": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const invitation = this.#invitations.get(input.invitationId);
        const organization = invitation && this.#organizations.get(invitation.organizationId);
        if (!invitation || organization?.installation !== "active") {
          throw new ApiError(
            "not_found",
            "The invitation is not to one of this app's organizations.",
          );
        }
        if (new URL(input.url).origin !== this.#bookkeepingOrigin) {
          throw new ApiError("invalid_request", "Invitation links go to the app's own origin.");
        }
        if (invitation.status !== "pending") {
          throw new ApiError("conflict", "The invitation is no longer pending.");
        }
        if (!this.#emailConfigured) {
          return Response.json({ message: "Resend is not configured." }, { status: 500 });
        }
        if (!this.sentInvitations.some(({ url }) => url === input.url)) {
          this.sentInvitations.push({ to: invitation.email, url: input.url });
        }
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({ email: invitation.email }),
        );
      }
      case "invitations.accept": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const invitation = this.#invitations.get(input.invitationId);
        const organization = invitation && this.#organizations.get(invitation.organizationId);
        if (!invitation || organization?.installation !== "active") {
          throw new ApiError(
            "not_found",
            "The invitation is not to one of this app's organizations.",
          );
        }
        const user = this.#users.get(input.userId);
        if (!user || !this.#consents.has(user.id)) {
          throw new ApiError("forbidden", `User '${input.userId}' has not authorized this app.`);
        }
        if (invitation.email !== user.email) {
          throw new ApiError("forbidden", "The invitation is addressed to someone else.");
        }
        if (invitation.status === "pending") {
          invitation.status = "accepted";
          organization.members.set(user.id, {
            roles: invitation.roles,
            joinedAt: new Date().toISOString(),
          });
        }
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse(
            this.#membership(organization, organization.members.get(user.id)!.roles),
          ),
        );
      }
      default:
        throw new ApiError("not_found", `Unknown provisioning operation '${operationId}'.`);
    }
  }

  /**
   * How the user acts in the organization: as a member, or as a member of the organization
   * managing it, with their role there, owners as admins. Null when they do not.
   */
  #access(
    organization: Organization,
    userId: string,
  ): { roles: Role[]; through: OrganizationAccessRecord["through"] } | null {
    const member = organization.members.get(userId);
    if (member) {
      return { roles: member.roles, through: "membership" };
    }
    const managing =
      organization.managingOrganizationId === null
        ? undefined
        : this.#organizations.get(organization.managingOrganizationId)?.members.get(userId);
    return managing
      ? {
          roles: [...new Set(managing.roles.map((role) => (role === "owner" ? "admin" : role)))],
          through: "managing-organization",
        }
      : null;
  }

  #accessRecord(
    organization: Organization,
    access: { roles: Role[]; through: OrganizationAccessRecord["through"] },
  ): OrganizationAccessRecord {
    const managing =
      organization.managingOrganizationId === null
        ? null
        : this.#organizations.get(organization.managingOrganizationId)!;
    return {
      ...this.#membership(organization, access.roles),
      managingOrganization: managing && {
        organizationId: managing.id,
        name: managing.name,
        slug: managing.slug,
      },
      through: access.through,
    };
  }

  #membership(organization: Organization, roles: Role[]): OrganizationMembershipRecord {
    return {
      organization: {
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        jurisdiction: null,
        createdAt: organization.createdAt,
      },
      roles,
    };
  }

  #pendingInvitations(organization: Organization): Invitation[] {
    return [...this.#invitations.values()].filter(
      (invitation) =>
        invitation.organizationId === organization.id &&
        invitation.status === "pending" &&
        Date.parse(invitation.expiresAt) > Date.now(),
    );
  }

  #createUser(email: string): User {
    // Backoffice's email-code sign-up asks only for the address, so new accounts have no name.
    const user = { id: crypto.randomUUID(), email, name: "" };
    this.#users.set(user.id, user);
    return user;
  }

  #userByEmail(email: string): User | undefined {
    return [...this.#users.values()].find((user) => user.email === email);
  }

  #organizationBySlug(slug: string): Organization {
    const organization = [...this.#organizations.values()].find((org) => org.slug === slug);
    if (!organization) {
      throw new Error(`Backoffice has no organization ${slug}.`);
    }
    return organization;
  }
}

/** Backoffice numbers a slug that is taken in the same place. */
function nextSlug(name: string, taken: string[]): string {
  const base = slugify(name) || "untitled";
  let slug = base;
  for (let number = 2; taken.includes(slug); number++) {
    slug = `${base}-${number}`;
  }
  return slug;
}

type Operations = typeof backofficeApiV0.operations;

/** Parses the input and output with the operation's published schemas. */
function respond<TId extends keyof Operations>(
  operationId: TId,
  body: unknown,
  run: (input: z.output<Operations[TId]["input"]>) => z.input<Operations[TId]["output"]>,
): Response {
  const operation = backofficeApiV0.operations[operationId];
  const input = operation.input.safeParse(body);
  if (!input.success) {
    throw new ApiError("invalid_request", z.prettifyError(input.error));
  }
  const output: unknown = operation.output.parse(run(input.data as never));
  return output === undefined ? new Response(null, { status: 204 }) : Response.json(output);
}

function bearer(request: Request): string {
  return /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
}

function scopeUnavailable(message: string): Response {
  return Response.json({ error: "scope_unavailable", message }, { status: 403 });
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}.`);
  }
}
