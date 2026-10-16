import { z } from "zod";

/** How a scope names the organization and project it belongs to. */
export type BackofficeScopeNames = { organization: object; project: object };

/** An organization scope, generic over how it names the organization. */
export type BackofficeOrganizationScope<TNames extends BackofficeScopeNames> = {
  kind: "org";
} & TNames["organization"];

/** A user's personal scope. */
export type BackofficeUserScope = { kind: "user"; userId: string };

/** The scopes that own everything else: every scope chain ends in an organization or a user. */
export type BackofficeRootOwner<TNames extends BackofficeScopeNames> =
  | BackofficeOrganizationScope<TNames>
  | BackofficeUserScope;

/**
 * An installed app's own workspace, one per installation. The installation's owner owns it, and
 * the app ID is stable, so every spelling names the app by ID.
 */
export type BackofficeAppScope<TNames extends BackofficeScopeNames> = {
  kind: "app";
  owner: BackofficeRootOwner<TNames>;
  appId: string;
};

/** The scopes that can own a project. Projects never own projects. */
export type BackofficeProjectOwner<TNames extends BackofficeScopeNames> =
  | BackofficeRootOwner<TNames>
  | BackofficeAppScope<TNames>;

/**
 * Where Backoffice work runs, generic over how it names its organization and project: by ID at
 * runtime, by slug in Backoffice URLs, or as loaded records. App and project scopes name their
 * owner as a scope.
 */
export type BackofficeScope<TNames extends BackofficeScopeNames> =
  | { kind: "system" }
  | BackofficeRootOwner<TNames>
  | BackofficeAppScope<TNames>
  | ({ kind: "project"; owner: BackofficeProjectOwner<TNames> } & TNames["project"]);

/** Scopes that own resources; system scope only administers them. */
export type BackofficeRoutable<TScope extends { kind: string }> = Exclude<
  TScope,
  { kind: "system" }
>;

export type BackofficeScopeIdNames = {
  organization: { orgId: string };
  project: { projectId: string };
};

/** Where Backoffice work runs, naming organizations and projects by ID. */
export type BackofficeContextScope = BackofficeScope<BackofficeScopeIdNames>;

export type BackofficeRoutableScope = BackofficeRoutable<BackofficeContextScope>;

/**
 * Public routes and CLI arguments name organizations by slug, never by internal ID. Projects keep
 * their ID, because public URLs are registered with external services and must survive renames.
 */
export type BackofficeScopePublicNames = {
  organization: { orgSlug: string };
  project: { projectId: string };
};

export type BackofficePublicScope = BackofficeScope<BackofficeScopePublicNames>;

const backofficeSystemScopeSchema = z.lazy(() => z.strictObject({ kind: z.literal("system") }));
export const backofficeOrganizationScopeSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("org"),
    orgId: z.string().trim().min(1),
  }),
);
export const backofficeUserScopeSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("user"),
    userId: z.string().trim().min(1),
  }),
);
export const backofficeRootOwnerSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [backofficeOrganizationScopeSchema, backofficeUserScopeSchema]),
);
export const backofficeAppScopeSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("app"),
    owner: backofficeRootOwnerSchema,
    appId: z.string().trim().min(1),
  }),
);
export const backofficeProjectScopeSchema = z.lazy(() =>
  z.strictObject({
    kind: z.literal("project"),
    owner: z.discriminatedUnion("kind", [
      backofficeOrganizationScopeSchema,
      backofficeUserScopeSchema,
      backofficeAppScopeSchema,
    ]),
    projectId: z.string().trim().min(1),
  }),
);

export const backofficeRoutableScopeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    backofficeOrganizationScopeSchema,
    backofficeUserScopeSchema,
    backofficeAppScopeSchema,
    backofficeProjectScopeSchema,
  ]),
) satisfies z.ZodType<BackofficeRoutableScope>;

export const backofficeContextScopeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    backofficeSystemScopeSchema,
    backofficeOrganizationScopeSchema,
    backofficeUserScopeSchema,
    backofficeAppScopeSchema,
    backofficeProjectScopeSchema,
  ]),
) satisfies z.ZodType<BackofficeContextScope>;

export function isBackofficeRoutableScope(
  scope: BackofficeContextScope,
): scope is BackofficeRoutableScope {
  return scope.kind !== "system";
}

type ProjectNamesOf<TScope> = Omit<Extract<TScope, { kind: "project" }>, "kind" | "owner">;

/** The root owners among a scope type's kinds, found by following each owner chain. */
export type BackofficeRootOwnerOf<TScope> = TScope extends { kind: "org" } | { kind: "user" }
  ? TScope
  : TScope extends { owner: infer TOwner }
    ? BackofficeRootOwnerOf<TOwner>
    : never;

/** The organization scope a scope type's chains can end in. */
export type BackofficeOrganizationScopeOf<TScope> = Extract<
  BackofficeRootOwnerOf<TScope>,
  { kind: "org" }
>;

type OrganizationNamesOf<TScope> = Omit<BackofficeOrganizationScopeOf<TScope>, "kind">;

/** `null` when a scope type includes the system scope, which no root owner owns. */
type NullIfSystem<TScope> = [Extract<TScope, { kind: "system" }>] extends [never] ? never : null;

/** `null` when a scope type includes scopes that belong to no organization. */
type NullUnlessOrganizationOwned<TScope> = [
  Extract<TScope, { kind: "system" }> | Extract<BackofficeRootOwnerOf<TScope>, { kind: "user" }>,
] extends [never]
  ? never
  : null;

/**
 * The organization or user at the end of a scope's owner chain, who answers for everything in it.
 * The system scope has none, so the result is only nullable when the scope type includes it.
 */
export function backofficeScopeRootOwner<TScope extends BackofficeScope<BackofficeScopeNames>>(
  scope: TScope,
): BackofficeRootOwnerOf<TScope> | NullIfSystem<TScope> {
  const named: BackofficeScope<BackofficeScopeNames> = scope;
  switch (named.kind) {
    case "org":
    case "user":
      return named as BackofficeRootOwnerOf<TScope>;
    case "app":
    case "project":
      return backofficeScopeRootOwner(named.owner) as BackofficeRootOwnerOf<TScope>;
    case "system":
      return null as NullIfSystem<TScope>;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: named satisfies never });
  }
}

/**
 * The organization a scope belongs to: its root owner, when that is an organization. The result is
 * only nullable when the scope type includes scopes that a user or nobody owns.
 */
export function backofficeScopeOrganization<TScope extends BackofficeScope<BackofficeScopeNames>>(
  scope: TScope,
): BackofficeOrganizationScopeOf<TScope> | NullUnlessOrganizationOwned<TScope> {
  const owner: BackofficeRootOwner<BackofficeScopeNames> | null = backofficeScopeRootOwner(scope);
  return (owner?.kind === "org" ? owner : null) as
    | BackofficeOrganizationScopeOf<TScope>
    | NullUnlessOrganizationOwned<TScope>;
}

/**
 * The scope whose projects sit beside a workspace: the workspace itself, or a project's owner.
 * The system scope owns no projects.
 */
export function backofficeScopeProjectOwner<TNames extends BackofficeScopeNames>(
  scope: BackofficeScope<TNames>,
): BackofficeProjectOwner<TNames> | null {
  switch (scope.kind) {
    case "system":
      return null;
    case "project":
      return scope.owner;
    case "org":
    case "user":
    case "app":
      return scope;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}

/**
 * The organization whose own workspace a scope is: the organization, or one of its projects. Unlike
 * `backofficeScopeOrganization`, an installed app's workspace is not its organization's.
 */
export function backofficeWorkspaceOrganization<TNames extends BackofficeScopeNames>(
  scope: BackofficeScope<TNames>,
): BackofficeOrganizationScope<TNames> | null {
  const owner = backofficeScopeProjectOwner(scope);
  return owner?.kind === "org" ? owner : null;
}

/** Renames the records a scope refers to, e.g. from route slugs to runtime IDs; kinds are kept. */
export function mapBackofficeScopeNames<
  TScope extends BackofficeScope<BackofficeScopeNames>,
  TOrganization extends object,
  TProject extends object,
>(
  scope: TScope,
  map: {
    organization(names: OrganizationNamesOf<TScope>): TOrganization;
    project(names: ProjectNamesOf<TScope>): TProject;
  },
): Extract<
  BackofficeScope<{ organization: TOrganization; project: TProject }>,
  { kind: TScope["kind"] }
> {
  return renameScope(scope) as Extract<
    BackofficeScope<{ organization: TOrganization; project: TProject }>,
    { kind: TScope["kind"] }
  >;

  // Narrowing a generic scope by kind does not narrow `TScope`, so each kind's names are cast to
  // the callback types. A project's owner is renamed as a scope of its own.
  function renameScope(
    named: BackofficeScope<BackofficeScopeNames>,
  ): BackofficeScope<{ organization: TOrganization; project: TProject }> {
    switch (named.kind) {
      case "system":
        return { kind: "system" };
      case "org":
        return { kind: "org", ...map.organization(named as OrganizationNamesOf<TScope>) };
      case "user":
        return { kind: "user", userId: named.userId };
      case "app":
        return {
          kind: "app",
          owner: renameScope(named.owner) as BackofficeRootOwner<{
            organization: TOrganization;
            project: TProject;
          }>,
          appId: named.appId,
        };
      case "project":
        return {
          kind: "project",
          ...map.project(named as unknown as ProjectNamesOf<TScope>),
          owner: renameScope(named.owner) as BackofficeProjectOwner<{
            organization: TOrganization;
            project: TProject;
          }>,
        };
      default:
        throw new Error("Unsupported Backoffice scope kind.", { cause: named satisfies never });
    }
  }
}

export function backofficeContextScopesEqual(
  left: BackofficeContextScope,
  right: BackofficeContextScope,
): boolean {
  // The path segment names a scope exactly, so equal segments mean equal scopes.
  return backofficeScopePathSegment(left) === backofficeScopePathSegment(right);
}

/**
 * A scope restriction is an upper bound: a project's owner contains the project. Containment does
 * not chain, so an organization contains neither its apps' workspaces nor their projects.
 */
export function backofficeScopeContains(
  restriction: BackofficeContextScope,
  target: BackofficeContextScope,
): boolean {
  return (
    backofficeContextScopesEqual(restriction, target) ||
    (target.kind === "project" && backofficeContextScopesEqual(restriction, target.owner))
  );
}

const INVALID_BACKOFFICE_SCOPE = "INVALID_BACKOFFICE_SCOPE";

/** A scope could not be read from untrusted text, such as a URL. */
export class BackofficeScopeParseError extends Error {
  readonly code = INVALID_BACKOFFICE_SCOPE;

  constructor(message: string) {
    super(message);
    this.name = "BackofficeScopeParseError";
  }
}

/** Matches by code too, because errors lose their class across module copies and RPC. */
export function isBackofficeScopeParseError(error: unknown): error is BackofficeScopeParseError {
  return (
    error instanceof BackofficeScopeParseError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === INVALID_BACKOFFICE_SCOPE)
  );
}

/** How one of a scope's names is written in text, and what a parse error calls it. */
export type BackofficeNameCodec<TName extends object> = {
  label: string;
  format(name: TName): string;
  parse(value: string): TName;
};

export type BackofficeScopeCodec<TNames extends BackofficeScopeNames> = {
  organization: BackofficeNameCodec<TNames["organization"]>;
  project: BackofficeNameCodec<TNames["project"]>;
};

const organizationIdCodec: BackofficeNameCodec<{ orgId: string }> = {
  label: "org id",
  format: (name) => name.orgId,
  parse: (orgId) => ({ orgId }),
};

const projectIdCodec: BackofficeNameCodec<{ projectId: string }> = {
  label: "project id",
  format: (name) => name.projectId,
  parse: (projectId) => ({ projectId }),
};

export const backofficeOrganizationSlugCodec: BackofficeNameCodec<{ orgSlug: string }> = {
  label: "organization slug",
  format: (name) => name.orgSlug,
  parse: (orgSlug) => ({ orgSlug }),
};

export const backofficeScopeIdCodec: BackofficeScopeCodec<BackofficeScopeIdNames> = {
  organization: organizationIdCodec,
  project: projectIdCodec,
};

export const backofficePublicScopeCodec: BackofficeScopeCodec<BackofficeScopePublicNames> = {
  organization: backofficeOrganizationSlugCodec,
  project: projectIdCodec,
};

/**
 * Names a scope in one URL path segment, e.g. `project:org:<org>:<projectId>`: app and project
 * scopes embed their owner's segment. Components are URI-encoded, so `:` only ever separates them.
 */
export function formatBackofficeScopeSegment<TNames extends BackofficeScopeNames>(
  scope: BackofficeScope<TNames>,
  codec: BackofficeScopeCodec<TNames>,
): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return `org:${encodeURIComponent(codec.organization.format(scope))}`;
    case "user":
      return `user:${encodeURIComponent(scope.userId)}`;
    case "app":
      return `app:${formatBackofficeScopeSegment<TNames>(scope.owner, codec)}:${encodeURIComponent(scope.appId)}`;
    case "project":
      return `project:${formatBackofficeScopeSegment<TNames>(scope.owner, codec)}:${encodeURIComponent(codec.project.format(scope))}`;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}

/** Reads a segment written by `formatBackofficeScopeSegment`; anything else is a parse error. */
export function parseBackofficeScopeSegment<TNames extends BackofficeScopeNames>(
  segment: string,
  codec: BackofficeScopeCodec<TNames>,
): BackofficeScope<TNames> {
  const components = segment.split(":");
  let next = 0;
  const scope = readScope();
  if (next !== components.length) {
    throw new BackofficeScopeParseError(
      `${scopeLabel(scope.kind)} scope has unexpected components after it.`,
    );
  }
  return scope;

  // Reads one scope from the components, leaving those after it for an enclosing scope.
  function readScope(): BackofficeScope<TNames> {
    const kind = components[next++];
    switch (kind) {
      case "system":
        return { kind: "system" };
      case "org":
        return {
          kind: "org",
          ...codec.organization.parse(readComponent(codec.organization.label)),
        } as BackofficeOrganizationScope<TNames>;
      case "user":
        return { kind: "user", userId: readComponent("user id") };
      case "app": {
        const owner = readOwner("App");
        if (owner.kind !== "org" && owner.kind !== "user") {
          throw new BackofficeScopeParseError(`${scopeLabel(owner.kind)} scope cannot own an app.`);
        }
        return { kind: "app", owner, appId: readComponent("app id") };
      }
      case "project": {
        const owner = readOwner("Project");
        if (owner.kind === "system" || owner.kind === "project") {
          throw new BackofficeScopeParseError(
            `${scopeLabel(owner.kind)} scope cannot own a project.`,
          );
        }
        return {
          kind: "project",
          owner,
          ...codec.project.parse(readComponent(codec.project.label)),
        };
      }
      default:
        throw new BackofficeScopeParseError(`Unknown scope kind '${kind ?? ""}'.`);
    }
  }

  function readOwner(ownedLabel: string): BackofficeScope<TNames> {
    if (next === components.length) {
      throw new BackofficeScopeParseError(`${ownedLabel} scope requires an owner scope.`);
    }
    return readScope();
  }

  function readComponent(label: string): string {
    const value = components[next++];
    if (value === undefined) {
      throw new BackofficeScopeParseError(`Missing ${label}.`);
    }
    return decodeSegmentComponent(value, label);
  }
}

function decodeSegmentComponent(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new BackofficeScopeParseError(`Invalid ${label} encoding.`);
  }
  if (!decoded) {
    throw new BackofficeScopeParseError(`Missing ${label}.`);
  }
  return decoded;
}

function scopeLabel(kind: BackofficeContextScope["kind"]): string {
  switch (kind) {
    case "system":
      return "System";
    case "org":
      return "Org";
    case "user":
      return "User";
    case "app":
      return "App";
    case "project":
      return "Project";
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: kind satisfies never });
  }
}

/**
 * Escapes scope text for a URL path segment that a router decodes once before it is parsed. Paths
 * allow a literal `:`, so the separator stays readable; a `:` inside a component was already
 * escaped when the segment was formatted.
 */
export function encodeBackofficeScopeForPath(text: string): string {
  return encodeURIComponent(text).replaceAll("%3A", ":");
}

/** Names a scope in two URL path segments, `<kind>/<id>`, e.g. `project/org:acme:website`. */
export function formatBackofficeScopeRoutePath<TNames extends BackofficeScopeNames>(
  scope: BackofficeScope<TNames>,
  codec: BackofficeScopeCodec<TNames>,
): string {
  if (scope.kind === "system") {
    return "system/system";
  }
  const components = formatBackofficeScopeSegment(scope, codec).slice(scope.kind.length + 1);
  return `${scope.kind}/${encodeBackofficeScopeForPath(components)}`;
}

/** Reads the decoded `<kind>/<id>` route parameters written by `formatBackofficeScopeRoutePath`. */
export function parseBackofficeScopeRouteParams<TNames extends BackofficeScopeNames>(
  params: { scopeKind: string; scopeId: string },
  codec: BackofficeScopeCodec<TNames>,
): BackofficeScope<TNames> {
  if (params.scopeKind === "system") {
    if (params.scopeId !== "system") {
      throw new BackofficeScopeParseError("System scope requires the system id.");
    }
    return { kind: "system" };
  }
  return parseBackofficeScopeSegment(`${params.scopeKind}:${params.scopeId}`, codec);
}

/** Names an ID-backed scope in one URL path segment, as the Backoffice API addresses scopes. */
export function backofficeScopePathSegment(scope: BackofficeContextScope): string {
  return formatBackofficeScopeSegment(scope, backofficeScopeIdCodec);
}

/** Reads a segment written by `backofficeScopePathSegment`; anything else is a parse error. */
export function parseBackofficeScopePathSegment(segment: string): BackofficeContextScope {
  return parseBackofficeScopeSegment(segment, backofficeScopeIdCodec);
}
