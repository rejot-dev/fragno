import { createHash } from "node:crypto";

import {
  BACKOFFICE_API_ERROR_STATUS,
  type BackofficeApiErrorCode,
} from "@fragno-dev/backoffice-api/errors";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import type { OrganizationMembershipRecord } from "@fragno-dev/backoffice-api/v0/organization";
import { backofficeProvisioningOperations } from "@fragno-dev/backoffice-api/v0/provisioning";
import {
  backofficeContextScopeSchema,
  parseBackofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

type Role = "owner" | "admin" | "member";
type User = { id: string; email: string; name: string };
type Organization = {
  id: string;
  externalId: string;
  name: string;
  slug: string;
  createdAt: string;
  members: Map<string, { roles: Role[]; joinedAt: string }>;
  installation: "active" | "uninstalled";
  /** Projects Bookkeeping provisioned, by its identifier for them. */
  projects: Map<string, { id: string; slug: string; name: string }>;
};
type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  roles: Role[];
  status: "pending" | "accepted";
  expiresAt: string;
  createdAt: string;
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
  readonly #executionTokens = new Map<string, { principal: Principal; organizationId: string }>();
  #reachable = true;

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

  /** A Backoffice without email delivery, as a local one usually is, fails to send emails. */
  setEmailConfigured(configured: boolean): void {
    this.#emailConfigured = configured;
  }

  /** While Backoffice is unreachable, every request fails as a network failure does. */
  setReachable(reachable: boolean): void {
    this.#reachable = reachable;
  }

  /** An owner changes things in Backoffice's own UI. */
  readonly admin = {
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
  };

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
      if (url.pathname === "/api/backoffice/execution-token") {
        return await this.#executionToken(request);
      }
      const provisioning = /^\/api\/v0\/provisioning\/([^/]+)$/u.exec(url.pathname);
      if (provisioning) {
        return await this.#provision(request, provisioning[1]);
      }
      const operation = /^\/api\/v0\/scopes\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
      if (operation) {
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
   * installed there, and a user's credential needs the user's own current membership.
   */
  async #executionToken(request: Request): Promise<Response> {
    const principal = this.#accessTokens.get(bearer(request));
    if (!principal) {
      throw new ApiError("authentication_failed", "A valid OAuth bearer token is required.");
    }
    const { scope } = z.object({ scope: backofficeContextScopeSchema }).parse(await request.json());
    if (scope.kind !== "org") {
      return scopeUnavailable("Bookkeeping only works in organizations.");
    }
    const organization = this.#organizations.get(scope.orgId);
    if (organization?.installation !== "active") {
      return scopeUnavailable("This app is not installed by the requested scope's owner.");
    }
    if (principal.kind === "user" && !organization.members.has(principal.userId)) {
      return scopeUnavailable("You are not a member of this organization.");
    }
    const accessToken = randomToken();
    this.#executionTokens.set(accessToken, { principal, organizationId: organization.id });
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
    if (scope.kind !== "org" || scope.orgId !== credential.organizationId) {
      throw new ApiError("forbidden", "The credential is bound to another scope.");
    }
    const organization = this.#organizations.get(credential.organizationId)!;
    if (organization.installation !== "active") {
      throw new ApiError("authentication_failed", "The installation is no longer active.");
    }
    // Organization operations act as a user; Backoffice offers them only to a user's credential.
    const userId = credential.principal.kind === "user" ? credential.principal.userId : null;
    const member = userId === null ? undefined : organization.members.get(userId);
    if (!member) {
      throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
    const body = request.headers.get("content-type") ? await request.json() : undefined;
    switch (operationId) {
      case "org.get":
        return respond("org.get", undefined, () => this.#membership(organization, member.roles));
      case "org.members.list":
        return respond("org.members.list", body, () => ({
          members: [...organization.members].map(([memberId, { roles, joinedAt }]) => {
            const user = this.#users.get(memberId)!;
            return { userId: user.id, name: user.name, email: user.email, roles, joinedAt };
          }),
          nextCursor: null,
          hasNextPage: false,
        }));
      case "org.invitations.create":
        return respond("org.invitations.create", body, ({ email, roles }) => {
          if (!member.roles.some((role) => MANAGING_ROLES.has(role))) {
            throw new ApiError("forbidden", "Only owners and admins invite.");
          }
          if (roles.includes("owner") && !member.roles.includes("owner")) {
            throw new ApiError("forbidden", "Only owners invite owners.");
          }
          const invitation: Invitation = {
            id: randomToken(),
            organizationId: organization.id,
            email,
            roles,
            status: "pending",
            expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
            createdAt: new Date().toISOString(),
          };
          this.#invitations.set(invitation.id, invitation);
          const { id, status: _status, ...record } = invitation;
          return {
            invitationId: id,
            ...record,
            url: `${this.origin}/backoffice/invitations/${id}`,
          };
        });
      default:
        throw new ApiError("not_found", `Operation '${operationId}' is not available here.`);
    }
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
          installation: "active",
          projects: new Map(),
        };
        this.#organizations.set(organization.id, organization);
        return Response.json(
          backofficeProvisioningOperations[operationId].output.parse({
            organizationId: organization.id,
            slug: organization.slug,
            created: true,
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
          !organization.members.has(input.createdByUserId) ||
          !this.#consents.has(input.createdByUserId)
        ) {
          throw new ApiError(
            "forbidden",
            `User '${input.createdByUserId}' is not a member who authorized this app.`,
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

  #membership(organization: Organization, roles: Role[]): OrganizationMembershipRecord {
    return {
      organization: {
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
      },
      roles,
    };
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
  return Response.json(operation.output.parse(run(input.data as never)));
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
