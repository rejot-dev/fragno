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
import type {
  PiAgentActivity,
  PiAgentDefinitionCreate,
  PiPromptStatus,
} from "@fragno-dev/backoffice-api/v0/pi";
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
  /** What it does while the agent runs, or once someone stopped it, as asked; null when not asked. */
  whenBusy: string | null;
  whenPaused: string | null;
  prompter: Principal;
  status: PiPromptStatus;
  /** The tools the agent ran answering it, as `pi.agent.activity` reads a subagent's. */
  activity: PiAgentActivity;
};
type Share = {
  shareId: string;
  from: BackofficeRoutableScope;
  /** The key prefix of the blobs it opens. */
  prefix: string;
  with: BackofficeRoutableScope;
  sharedAt: string;
};
type AcceptedShare = {
  shareId: string;
  name: string;
  from: BackofficeRoutableScope;
  /** The shared blobs' key prefix, as the sharing scope named it. */
  prefix: string;
  /** The accepting scope's workspace key. */
  scope: string;
  acceptedAt: string;
};
type StoredBlob = { bytes: Uint8Array<ArrayBuffer>; contentType: string; etag: string };
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
  /** Blobs by scope and key, e.g. the documents Bookkeeping stores in a project. */
  readonly #blobs = new Map<string, StoredBlob>();
  /**
   * Uploads not completed yet, by upload ID, with the bytes storage took for them, if any. As in
   * Backoffice, another upload of the same key replaces one, which then cannot complete.
   */
  readonly #uploads = new Map<
    string,
    { blobKey: string; contentType: string; bytes: Uint8Array<ArrayBuffer> | null }
  >();
  /** What each download URL reads, by its token: whatever the blob holds when it is read. */
  readonly #downloads = new Map<string, string>();
  /** Agents defined in each workspace, by scope and name. */
  readonly #agents = new Map<string, PiAgentDefinitionCreate>();
  /** Prompts agents received, in the order they arrived. */
  readonly #prompts: Prompt[] = [];
  /** Agents someone stopped and nobody resumed since, by scope and name. */
  readonly #stoppedAgents = new Set<string>();
  /** The tickets opening agents' sockets, and whose they are. */
  readonly #watchTickets = new Map<
    string,
    { scope: string; agentName: string; prompter: Principal }
  >();
  /** Agents' conversations before their active context, oldest first, by scope and name. */
  readonly #histories = new Map<string, readonly { id: number }[]>();
  /** Who read agents' earlier history, in the order they read it. */
  readonly #historyReads: { scope: string; agentName: string; reader: Principal }[] = [];
  /**
   * Blobs one scope shares with another, by share ID; revoking the share deletes it. Bookkeeping
   * shares no folders, so neither does this fake.
   */
  readonly #shares = new Map<string, Share>();
  /** Shares scopes accepted, by the accepting scope and the name they mount the share under. */
  readonly #acceptedShares = new Map<string, AcceptedShare>();
  #reachable = true;
  /** Provisioning operations whose next response is lost after Backoffice did the work. */
  readonly #failNextResponse = new Set<string>();
  /** Operations whose next request is lost before it reaches Backoffice. */
  readonly #failNextRequest = new Set<string>();
  /** How many requests for each scoped operation reached Backoffice. */
  readonly #operationCounts = new Map<string, number>();
  /** What happens elsewhere while Backoffice works on the next request for an operation. */
  readonly #beforeNextAnswer = new Map<string, () => Promise<void>>();
  /** What happens elsewhere after Backoffice answered the next request, before the answer arrives. */
  readonly #beforeNextDelivery = new Map<string, () => Promise<void>>();

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

  /** How many requests for the scoped operation `operationId` reached Backoffice. */
  operationCount(operationId: string): number {
    return this.#operationCounts.get(operationId) ?? 0;
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

  /**
   * `happen` runs after Backoffice answered the next request for `operationId`, before the answer
   * reaches the caller, e.g. a newer request overtaking a slow one.
   */
  beforeNextDelivery(operationId: string, happen: () => Promise<void>): void {
    this.#beforeNextDelivery.set(operationId, happen);
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
    whenBusy: string | null;
    whenPaused: string | null;
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
        whenBusy: prompt.whenBusy,
        whenPaused: prompt.whenPaused,
        prompter: this.#who(prompt.prompter),
        status: prompt.status.status,
      }));
  }

  /** Whether someone stopped one of the agents of a project of the organization, and nobody resumed it. */
  agentStopped(slug: string, project: string, agentName: string): boolean {
    return this.#stoppedAgents.has(this.#projectFileKey(slug, project, agentName));
  }

  /**
   * The agent a ticket opens the socket of in one of the organization's projects, and who asked for
   * it, as `prompts` names them; null for no ticket Backoffice issued there.
   */
  watchTicket(
    slug: string,
    project: string,
    ticket: string,
  ): { agentName: string; watcher: string } | null {
    const issued = this.#watchTickets.get(ticket);
    return issued?.scope === this.#projectFileKey(slug, project, "")
      ? { agentName: issued.agentName, watcher: this.#who(issued.prompter) }
      : null;
  }

  /** Gives an agent in one of the organization's projects history before its active context. */
  setHistory(
    slug: string,
    project: string,
    agentName: string,
    entries: readonly { id: number }[],
  ): void {
    this.#histories.set(this.#projectFileKey(slug, project, agentName), entries);
  }

  /** Who read the earlier history of agents in one of the organization's projects, as `prompts` names them. */
  historyReaders(slug: string, project: string): { agentName: string; reader: string }[] {
    const scope = this.#projectFileKey(slug, project, "");
    return this.#historyReads
      .filter((read) => read.scope === scope)
      .map((read) => ({ agentName: read.agentName, reader: this.#who(read.reader) }));
  }

  #who(principal: Principal): string {
    return principal.kind === "user" ? this.#users.get(principal.userId)!.email : "installation";
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

  /** The agent answering the prompt submitted as `requestId` has run `activity` so far. */
  reportActivity(requestId: string, activity: PiAgentActivity): void {
    const prompt = this.#prompts.find((candidate) => candidate.requestId === requestId);
    if (!prompt) {
      throw new Error(`No agent received prompt ${requestId}.`);
    }
    prompt.activity = activity;
  }

  /**
   * The shares one of the organization's projects accepted and may read, by name, with the key
   * prefix each opens: those whose sharing scope has not revoked them.
   */
  mountedShares(slug: string, project: string): { name: string; prefix: string }[] {
    const scope = this.#projectFileKey(slug, project, "");
    return [...this.#acceptedShares.values()].flatMap((accepted) => {
      const share = this.#shares.get(accepted.shareId);
      return accepted.scope === scope && share
        ? [{ name: accepted.name, prefix: share.prefix }]
        : [];
    });
  }

  /** The key prefixes one of the organization's projects shares and has not revoked. */
  standingShares(slug: string, project: string): string[] {
    const scope = this.#projectFileKey(slug, project, "");
    return [...this.#shares.values()].flatMap((share) =>
      `${backofficeScopePathSegment(share.from)} ` === scope ? [share.prefix] : [],
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

  /** The bytes of one of the organization's projects' blobs, if it has one under `key`. */
  blob(slug: string, project: string, key: string): Uint8Array | undefined {
    return this.#blobs.get(this.#projectFileKey(slug, project, key))?.bytes;
  }

  /** The keys of every blob of one of the organization's projects. */
  blobKeys(slug: string, project: string): string[] {
    const prefix = this.#projectFileKey(slug, project, "");
    return [...this.#blobs.keys()].flatMap((key) =>
      key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
    );
  }

  /** An owner changes things in Backoffice's own UI. */
  readonly admin = {
    /** A member defines one of a project's agents, or changes its definition. */
    defineAgent: (slug: string, project: string, definition: PiAgentDefinitionCreate) => {
      this.#agents.set(this.#projectFileKey(slug, project, definition.agentName), definition);
    },
    /** Someone replaces one of a project's blobs, or deletes it with null. */
    replaceBlob: (slug: string, project: string, key: string, bytes: Uint8Array | null) => {
      const blobKey = this.#projectFileKey(slug, project, key);
      if (bytes === null) {
        this.#blobs.delete(blobKey);
      } else {
        this.#blobs.set(blobKey, {
          bytes: new Uint8Array(bytes),
          contentType: "application/octet-stream",
          etag: crypto.randomUUID(),
        });
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
    /**
     * A global administrator has the organization at `managerSlug` manage the one at `slug`, or
     * ends its management with null.
     */
    setManager: (slug: string, managerSlug: string | null) => {
      this.#organizationBySlug(slug).managingOrganizationId =
        managerSlug === null ? null : this.#organizationBySlug(managerSlug).id;
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
      // Presigned storage URLs, which hold their authority: no credential.
      const storage = /^\/storage\/(uploads|downloads)\/([^/]+)$/u.exec(url.pathname);
      if (storage) {
        return await this.#storage(request, storage[1] === "uploads", storage[2]);
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
        this.#operationCounts.set(operation[2], this.operationCount(operation[2]) + 1);
        const happen = this.#beforeNextAnswer.get(operation[2]);
        this.#beforeNextAnswer.delete(operation[2]);
        await happen?.();
        const response = await this.#operate(request, operation[1], operation[2]);
        const delivery = this.#beforeNextDelivery.get(operation[2]);
        this.#beforeNextDelivery.delete(operation[2]);
        await delivery?.();
        return response;
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

  async #storage(request: Request, upload: boolean, token: string): Promise<Response> {
    if (upload && request.method === "PUT") {
      const pending = this.#uploads.get(token);
      if (!pending || request.headers.get("content-type") !== pending.contentType) {
        return new Response(null, { status: 403 });
      }
      pending.bytes = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 200 });
    }
    const blobKey = upload ? undefined : this.#downloads.get(token);
    const blob = blobKey === undefined ? undefined : this.#blobs.get(blobKey);
    if (request.method !== "GET" || blobKey === undefined) {
      return new Response(null, { status: 403 });
    }
    return blob
      ? new Response(blob.bytes, { headers: { "Content-Type": blob.contentType } })
      : new Response(null, { status: 404 });
  }

  #blobOf(key: string, blob: StoredBlob) {
    return {
      key,
      sizeBytes: blob.bytes.byteLength,
      contentType: blob.contentType,
      etag: blob.etag,
    };
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
      case "pi.agent.get":
        return respond("pi.agent.get", body, ({ agentName }) => {
          const definition = this.#agents.get(key(agentName));
          if (!definition) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          // Its first prompt provisions its conversation; subagents run in conversations of their own.
          const provisioned = this.#prompts.some(
            (prompt) =>
              prompt.scope === key("") && prompt.agentName === agentName && !prompt.subagent,
          );
          return { ...definition, steward: { kind: "members" as const }, provisioned };
        });
      case "pi.agent.update":
        return respond("pi.agent.update", body, (definition) => {
          if (!this.#agents.has(key(definition.agentName))) {
            throw new ApiError(
              "not_found",
              `No agent in this scope is named '${definition.agentName}'.`,
            );
          }
          this.#agents.set(key(definition.agentName), definition);
          return { ...definition, steward: { kind: "members" as const } };
        });
      case "pi.prompt.submit":
        return respond("pi.prompt.submit", body, (input) => {
          const { agentName, requestId, content, subagent, whenBusy, whenPaused } = input;
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          if (whenPaused === "resume") {
            this.#stoppedAgents.delete(key(agentName));
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
              whenBusy: whenBusy ?? null,
              whenPaused: whenPaused ?? null,
              prompter: principal,
              status: { requestId: id, status: "queued" },
              activity: { tools: [], omitted: 0 },
            });
          }
          return { requestId: id, status: "queued" as const };
        });
      case "pi.agent.stop":
        return respond("pi.agent.stop", body, ({ agentName }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          this.#stoppedAgents.add(key(agentName));
          return { stopped: true as const };
        });
      case "pi.agent.resume":
        return respond("pi.agent.resume", body, ({ agentName }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          this.#stoppedAgents.delete(key(agentName));
          return { resumed: true as const };
        });
      case "pi.agent.watchTicket":
        return respond("pi.agent.watchTicket", body, ({ agentName }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          const ticket = randomToken();
          this.#watchTickets.set(ticket, { scope: key(""), agentName, prompter: principal });
          return { ticket, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        });
      case "pi.agent.history":
        return respond("pi.agent.history", body, ({ agentName, before, cursor, pageSize }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          this.#historyReads.push({ scope: key(""), agentName, reader: principal });
          // Newest first, as Backoffice pages it; the cursor is where the next page starts.
          const earlier = (this.#histories.get(key(agentName)) ?? [])
            .filter((entry) => entry.id < before)
            .reverse();
          const start = cursor === null ? 0 : Number(cursor);
          const next = start + pageSize;
          return {
            entries: earlier.slice(start, next),
            cursor: next < earlier.length ? String(next) : null,
          };
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
      case "pi.agent.activity":
        return respond("pi.agent.activity", body, ({ agentName, subagent }) => {
          if (!this.#agents.has(key(agentName))) {
            throw new ApiError("not_found", `No agent in this scope is named '${agentName}'.`);
          }
          const prompt = this.#prompts.find(
            (candidate) =>
              candidate.scope === key("") &&
              candidate.agentName === agentName &&
              candidate.subagent &&
              candidate.requestId === subagent,
          );
          // A request that started no subagent has run nothing.
          return prompt?.activity ?? { tools: [], omitted: 0 };
        });
      case "shares.create":
        return respond("shares.create", body, (input) => {
          if (!isBackofficeRoutableScope(scope)) {
            throw new ApiError("not_found", "Only workspaces share blobs.");
          }
          if (input.of.kind !== "blobs") {
            throw new ApiError("invalid_request", "This fake Backoffice shares only blobs.");
          }
          const prefix = input.of.prefix;
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
            prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
            with: input.with,
            sharedAt: new Date().toISOString(),
          };
          this.#shares.set(share.shareId, share);
          return this.#share(share);
        });
      case "shares.accept":
        return respond("shares.accept", body, ({ from, shareId, name = shareId }) => {
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
            return this.#acceptedShare(accepted);
          }
          if (this.#acceptedShares.has(key(name))) {
            throw new ApiError("conflict", `This scope already mounts another share as ${name}.`);
          }
          const record = {
            shareId,
            name,
            from: share.from,
            prefix: share.prefix,
            scope: key(""),
            acceptedAt: new Date().toISOString(),
          };
          this.#acceptedShares.set(key(name), record);
          return this.#acceptedShare(record);
        });
      case "shares.list":
        return respond("shares.list", body, () => ({
          shared: [...this.#shares.values()]
            .filter((share) => key("") === `${backofficeScopePathSegment(share.from)} `)
            .map((share) => this.#share(share)),
          accepted: [...this.#acceptedShares.values()]
            .filter((accepted) => accepted.scope === key(""))
            .map((accepted) => this.#acceptedShare(accepted)),
        }));
      case "shares.revoke":
        return respond("shares.revoke", body, ({ shareId }) => {
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
      case "blobs.createUpload":
        return respond("blobs.createUpload", body, ({ key: blobKey, contentType }) => {
          for (const [replaced, upload] of this.#uploads) {
            if (upload.blobKey === key(blobKey)) {
              this.#uploads.delete(replaced);
            }
          }
          const uploadId = crypto.randomUUID();
          this.#uploads.set(uploadId, { blobKey: key(blobKey), contentType, bytes: null });
          return {
            uploadId,
            key: blobKey,
            url: `${this.origin}/storage/uploads/${uploadId}`,
            headers: { "Content-Type": contentType },
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        });
      case "blobs.completeUpload":
        return respond("blobs.completeUpload", body, ({ uploadId }) => {
          const upload = this.#uploads.get(uploadId);
          if (!upload || !upload.blobKey.startsWith(key(""))) {
            throw new ApiError("not_found", "UPLOAD_NOT_FOUND: The upload does not exist.");
          }
          if (upload.bytes === null) {
            throw new ApiError("invalid_request", "Storage holds no bytes for this upload yet.");
          }
          const blob = {
            bytes: upload.bytes,
            contentType: upload.contentType,
            etag: crypto.randomUUID(),
          };
          this.#uploads.delete(uploadId);
          this.#blobs.set(upload.blobKey, blob);
          return this.#blobOf(upload.blobKey.slice(key("").length), blob);
        });
      case "blobs.get":
        return respond("blobs.get", body, ({ key: blobKey }) => {
          const blob = this.#blobs.get(key(blobKey));
          return blob ? this.#blobOf(blobKey, blob) : null;
        });
      case "blobs.delete":
        return respond("blobs.delete", body, ({ key: blobKey }) => {
          this.#blobs.delete(key(blobKey));
        });
      case "blobs.createDownloadUrl":
        return respond("blobs.createDownloadUrl", body, ({ key: blobKey }) => {
          if (!this.#blobs.has(key(blobKey))) {
            throw new ApiError("not_found", `BLOB_NOT_FOUND: blob ${blobKey} does not exist.`);
          }
          const token = randomToken();
          this.#downloads.set(token, key(blobKey));
          return {
            url: `${this.origin}/storage/downloads/${token}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        });
      default:
        throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
  }

  #share(share: Share) {
    return {
      shareId: share.shareId,
      of: { kind: "blobs" as const, prefix: share.prefix },
      with: share.with,
      sharedAt: share.sharedAt,
    };
  }

  /** What the accepting scope sees of a share; one revoked since still shows until it revokes it. */
  #acceptedShare(accepted: AcceptedShare) {
    return {
      shareId: accepted.shareId,
      name: accepted.name,
      from: accepted.from,
      of: { kind: "blobs" as const, prefix: accepted.prefix },
      path: `/shared/${accepted.name}/`,
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
      case "organizations.listManaged": {
        const input = backofficeProvisioningOperations[operationId].input.parse(body);
        const managed = [...this.#organizations.values()].filter(
          (organization) =>
            organization.managingOrganizationId === input.managingOrganizationId &&
            organization.installation === "active",
        );
        const start = input.cursor === null ? 0 : Number(input.cursor);
        const end = start + input.pageSize;
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizations: managed.slice(start, end).map((organization) => ({
              organizationId: organization.id,
              name: organization.name,
              slug: organization.slug,
              jurisdiction: null,
              hasOwner: [...organization.members.values()].some(({ roles }) =>
                roles.includes("owner"),
              ),
            })),
            nextCursor: end < managed.length ? String(end) : null,
            hasNextPage: end < managed.length,
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
