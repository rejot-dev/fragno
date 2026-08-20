/** User facts required to name an initial organization. */
export type UserOrganizationUser = Readonly<{
  id: string;
  email: string;
  name: string;
}>;

/** Organization available to a user through membership. */
export type UserOrganizationRecord = Readonly<{
  id: string;
  slug: string;
}>;

type UserOrganizationCreateInput = Readonly<{
  name: string;
  slug: string;
  userId: string;
}>;

type UserOrganizationCreateResult =
  | Readonly<{ status: "created"; organization: UserOrganizationRecord }>
  | Readonly<{ status: "slug_conflict" }>;

/** Storage operations required to ensure a user belongs to at least one organization. */
export type UserOrganizationDependencies = Readonly<{
  findFirstByUserId(userId: string): Promise<UserOrganizationRecord | null>;
  findBySlug(slug: string): Promise<UserOrganizationRecord | null>;
  create(input: UserOrganizationCreateInput): Promise<UserOrganizationCreateResult>;
}>;

/** Result of ensuring organization membership, including whether this call created one. */
export type EnsureUserOrganizationResult = Readonly<{
  organization: UserOrganizationRecord;
  created: boolean;
}>;

/** Reports an unexpected or exhausted initial organization creation attempt with user context. */
export class UserOrganizationCreationError extends Error {
  constructor(userId: string, cause: unknown) {
    super(`Initial organization creation failed for user '${userId}'.`, { cause });
    this.name = "UserOrganizationCreationError";
  }
}

function organizationSlugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function initialOrganizationOwnerName(user: UserOrganizationUser): string {
  const ownerName = user.name.trim() || user.email.split("@", 1)[0]?.trim() || "User";
  return `${ownerName.charAt(0).toUpperCase()}${ownerName.slice(1)}`;
}

function initialOrganizationName(user: UserOrganizationUser): string {
  return `${initialOrganizationOwnerName(user)}'s Organisation`;
}

function initialOrganizationSlugBase(organizationName: string): string {
  return organizationSlugSegment(organizationName.replaceAll("'", ""));
}

const ORGANIZATION_SLUG_ADJECTIVES = [
  "amber",
  "brisk",
  "cedar",
  "cobalt",
  "cosmic",
  "crisp",
  "ember",
  "golden",
  "lunar",
  "mint",
  "nimble",
  "quiet",
  "silver",
  "solar",
  "velvet",
  "vivid",
] as const;

const ORGANIZATION_SLUG_NOUNS = [
  "badger",
  "comet",
  "falcon",
  "fox",
  "heron",
  "lynx",
  "otter",
  "panda",
  "raven",
  "rocket",
  "sparrow",
  "tiger",
  "whale",
  "wolf",
  "wren",
  "yak",
] as const;

function organizationSlugWordSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function organizationSlugWordPair(userId: string, attempt: number): string {
  const seed = organizationSlugWordSeed(userId);
  const adjectiveIndex = (seed + attempt * 5) % ORGANIZATION_SLUG_ADJECTIVES.length;
  const nounIndex =
    (Math.floor(seed / ORGANIZATION_SLUG_ADJECTIVES.length) + attempt * 7) %
    ORGANIZATION_SLUG_NOUNS.length;
  return `${ORGANIZATION_SLUG_ADJECTIVES[adjectiveIndex]}-${ORGANIZATION_SLUG_NOUNS[nounIndex]}`;
}

function* initialOrganizationSlugCandidates(
  user: UserOrganizationUser,
  organizationName: string,
): Generator<string> {
  const base = initialOrganizationSlugBase(organizationName);
  yield base;

  // Stable word pairs keep concurrent retries on the same unique-slug candidates.
  for (let attempt = 0; attempt < ORGANIZATION_SLUG_ADJECTIVES.length; attempt += 1) {
    yield `${base}-${organizationSlugWordPair(user.id, attempt)}`;
  }
}

/** Ensures a user belongs to one or more organizations without creating a personal-org identity. */
export async function ensureUserHasOrganization(
  user: UserOrganizationUser,
  dependencies: UserOrganizationDependencies,
): Promise<EnsureUserOrganizationResult> {
  const existingOrganization = await dependencies.findFirstByUserId(user.id);
  if (existingOrganization) {
    return { organization: existingOrganization, created: false };
  }

  const name = initialOrganizationName(user);
  for (const slug of initialOrganizationSlugCandidates(user, name)) {
    if (await dependencies.findBySlug(slug)) {
      const concurrentOrganization = await dependencies.findFirstByUserId(user.id);
      if (concurrentOrganization) {
        return { organization: concurrentOrganization, created: false };
      }
      continue;
    }

    let creation: UserOrganizationCreateResult;
    try {
      creation = await dependencies.create({ name, slug, userId: user.id });
    } catch (cause) {
      throw new UserOrganizationCreationError(user.id, cause);
    }
    if (creation.status === "created") {
      return { organization: creation.organization, created: true };
    }

    const concurrentOrganization = await dependencies.findFirstByUserId(user.id);
    if (concurrentOrganization) {
      return { organization: concurrentOrganization, created: false };
    }
  }

  throw new UserOrganizationCreationError(
    user.id,
    new Error("Initial organization slug allocation was exhausted."),
  );
}
