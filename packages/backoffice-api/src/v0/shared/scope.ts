import { z } from "zod";

/** How a scope names the organization and project it belongs to. */
export type BackofficeScopeNames = { organization: object; project: object };

/**
 * Where Backoffice work runs, generic over how it names its organization and project: by ID at
 * runtime, by slug in Backoffice URLs, or as loaded records.
 */
export type BackofficeScope<TNames extends BackofficeScopeNames> =
  | { kind: "system" }
  | ({ kind: "org" } & TNames["organization"])
  | { kind: "user"; userId: string }
  | ({ kind: "project" } & TNames["organization"] & TNames["project"]);

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

const backofficeSystemScopeSchema = z.strictObject({ kind: z.literal("system") });
export const backofficeOrganizationScopeSchema = z.strictObject({
  kind: z.literal("org"),
  orgId: z.string().trim().min(1),
});
export const backofficeUserScopeSchema = z.strictObject({
  kind: z.literal("user"),
  userId: z.string().trim().min(1),
});
export const backofficeProjectScopeSchema = z.strictObject({
  kind: z.literal("project"),
  orgId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

export const backofficeRoutableScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]) satisfies z.ZodType<BackofficeRoutableScope>;

export const backofficeContextScopeSchema = z.discriminatedUnion("kind", [
  backofficeSystemScopeSchema,
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]) satisfies z.ZodType<BackofficeContextScope>;

export function isBackofficeRoutableScope(
  scope: BackofficeContextScope,
): scope is BackofficeRoutableScope {
  return scope.kind !== "system";
}

type ScopeNamesOf<TScope, TKind> = Omit<Extract<TScope, { kind: TKind }>, "kind">;

/** The organization a scope belongs to; system and user scopes belong to none. */
export function backofficeScopeOrganization<TScope extends BackofficeScope<BackofficeScopeNames>>(
  scope: TScope,
): ScopeNamesOf<TScope, "org"> | null {
  const named = scope;
  // A project scope carries its organization's names alongside its own.
  return named.kind === "org" || named.kind === "project"
    ? (named as unknown as ScopeNamesOf<TScope, "org">)
    : null;
}

/** Renames the records a scope refers to, e.g. from route slugs to runtime IDs; kinds are kept. */
export function mapBackofficeScopeNames<
  TScope extends BackofficeScope<BackofficeScopeNames>,
  TOrganization extends object,
  TProject extends object,
>(
  scope: TScope,
  map: {
    organization(names: ScopeNamesOf<TScope, "org">): TOrganization;
    project(names: ScopeNamesOf<TScope, "project">): TProject;
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
  // the callback types. A project scope carries its organization's names too.
  function renameScope(
    named: BackofficeScope<BackofficeScopeNames>,
  ): BackofficeScope<{ organization: TOrganization; project: TProject }> {
    switch (named.kind) {
      case "system":
        return { kind: "system" };
      case "org":
        return { kind: "org", ...map.organization(named as ScopeNamesOf<TScope, "org">) };
      case "user":
        return { kind: "user", userId: named.userId };
      case "project":
        return {
          kind: "project",
          ...map.organization(named as unknown as ScopeNamesOf<TScope, "org">),
          ...map.project(named as ScopeNamesOf<TScope, "project">),
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

/** A scope restriction is an upper bound: an organization contains its projects. */
export function backofficeScopeContains(
  restriction: BackofficeContextScope,
  target: BackofficeContextScope,
): boolean {
  return (
    backofficeContextScopesEqual(restriction, target) ||
    (restriction.kind === "org" && target.kind === "project" && restriction.orgId === target.orgId)
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
 * Names a scope in one URL path segment, e.g. `project:<org>:<projectId>`. Components are
 * URI-encoded, so `:` only ever separates them.
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
    case "project":
      return `project:${encodeURIComponent(codec.organization.format(scope))}:${encodeURIComponent(codec.project.format(scope))}`;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
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

/** Reads a segment written by `formatBackofficeScopeSegment`; anything else is a parse error. */
export function parseBackofficeScopeSegment<TNames extends BackofficeScopeNames>(
  segment: string,
  codec: BackofficeScopeCodec<TNames>,
): BackofficeScope<TNames> {
  const [kind, ...ids] = segment.split(":");
  const expectIds = (count: number, message: string) => {
    if (ids.length !== count) {
      throw new BackofficeScopeParseError(message);
    }
  };
  const organization = (value: string | undefined) =>
    codec.organization.parse(decodeSegmentComponent(value ?? "", codec.organization.label));
  switch (kind) {
    case "system":
      expectIds(0, "System scope does not accept id components.");
      return { kind: "system" };
    case "org":
      expectIds(1, `Org scope requires exactly one ${codec.organization.label} component.`);
      return { kind: "org", ...organization(ids[0]) };
    case "user":
      expectIds(1, "User scope requires exactly one user id component.");
      return { kind: "user", userId: decodeSegmentComponent(ids[0] ?? "", "user id") };
    case "project":
      expectIds(
        2,
        `Project scope requires ${codec.organization.label} and ${codec.project.label} components.`,
      );
      return {
        kind: "project",
        ...organization(ids[0]),
        ...codec.project.parse(decodeSegmentComponent(ids[1] ?? "", codec.project.label)),
      };
    default:
      throw new BackofficeScopeParseError(`Unknown scope kind '${kind}'.`);
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

/** Names a scope in two URL path segments, `<kind>/<id>`, e.g. `project/acme:website`. */
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
