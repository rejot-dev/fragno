import { describe, expect, test, assert } from "vitest";

import {
  ensureUserHasOrganization,
  type UserOrganizationDependencies,
  UserOrganizationCreationError,
  type UserOrganizationRecord,
  type UserOrganizationUser,
} from "./auth-user-organization";

type StoredOrganization = UserOrganizationRecord & { memberUserIds: string[] };
type CreateInput = Parameters<UserOrganizationDependencies["create"]>[0];
type CreateResult = Awaited<ReturnType<UserOrganizationDependencies["create"]>>;

class MemoryUserOrganizations implements UserOrganizationDependencies {
  readonly organizations: StoredOrganization[];
  readonly #creationError: Error | null;
  #concurrentOrganization: StoredOrganization | null;
  creationCount = 0;
  readonly createInputs: CreateInput[] = [];

  constructor(input: {
    organizations: StoredOrganization[];
    creationError: Error | null;
    concurrentOrganization: StoredOrganization | null;
  }) {
    this.organizations = [...input.organizations];
    this.#creationError = input.creationError;
    this.#concurrentOrganization = input.concurrentOrganization;
  }

  async findFirstByUserId(userId: string): Promise<UserOrganizationRecord | null> {
    const organization = this.organizations.find((candidate) =>
      candidate.memberUserIds.includes(userId),
    );
    return organization ? { id: organization.id, slug: organization.slug } : null;
  }

  async findBySlug(slug: string): Promise<UserOrganizationRecord | null> {
    const organization = this.organizations.find((candidate) => candidate.slug === slug);
    return organization ? { id: organization.id, slug: organization.slug } : null;
  }

  async create(input: CreateInput): Promise<CreateResult> {
    this.creationCount += 1;
    this.createInputs.push(input);
    if (this.#creationError) {
      throw this.#creationError;
    }
    if (this.#concurrentOrganization) {
      this.organizations.push(this.#concurrentOrganization);
      this.#concurrentOrganization = null;
      return { status: "slug_conflict" };
    }
    if (this.organizations.some((organization) => organization.slug === input.slug)) {
      return { status: "slug_conflict" };
    }
    const organization = {
      id: `organization-${this.organizations.length + 1}`,
      slug: input.slug,
      memberUserIds: [input.userId],
    };
    this.organizations.push(organization);
    return {
      status: "created",
      organization: { id: organization.id, slug: organization.slug },
    };
  }
}

const user: UserOrganizationUser = {
  id: "user123456789",
  email: "Alice.Example@example.com",
  name: "alice Example",
};

function createMemoryUserOrganizations(
  organizations: StoredOrganization[] = [],
): MemoryUserOrganizations {
  return new MemoryUserOrganizations({
    organizations,
    creationError: null,
    concurrentOrganization: null,
  });
}

function occupiedOrganization(slug: string, index: number): StoredOrganization {
  return { id: `occupied-${index}`, slug, memberUserIds: ["another-user"] };
}

function allInitialOrganizationSlugs(): string[] {
  return [
    "alice-examples-organization",
    "alice-examples-organization-brisk-panda",
    "alice-examples-organization-ember-wren",
    "alice-examples-organization-quiet-lynx",
    "alice-examples-organization-amber-whale",
    "alice-examples-organization-crisp-fox",
    "alice-examples-organization-nimble-sparrow",
    "alice-examples-organization-vivid-comet",
    "alice-examples-organization-cosmic-raven",
    "alice-examples-organization-mint-yak",
    "alice-examples-organization-velvet-otter",
    "alice-examples-organization-cobalt-wolf",
    "alice-examples-organization-lunar-heron",
    "alice-examples-organization-solar-tiger",
    "alice-examples-organization-cedar-falcon",
    "alice-examples-organization-golden-rocket",
    "alice-examples-organization-silver-badger",
  ];
}

describe("ensureUserHasOrganization", () => {
  test("does not create a special organization when the user already belongs to one", async () => {
    const organizations = createMemoryUserOrganizations([
      { id: "shared-org", slug: "shared", memberUserIds: [user.id] },
    ]);

    const result = await ensureUserHasOrganization(user, organizations);

    expect(result).toEqual({
      created: false,
      organization: { id: "shared-org", slug: "shared" },
    });
    assert(organizations.creationCount === 0);
  });

  test("creates one organization and returns it on subsequent calls", async () => {
    const organizations = createMemoryUserOrganizations();

    const created = await ensureUserHasOrganization(user, organizations);
    const existing = await ensureUserHasOrganization(user, organizations);

    expect(created).toEqual({
      created: true,
      organization: { id: "organization-1", slug: "alice-examples-organization" },
    });
    expect(existing).toEqual({ created: false, organization: created.organization });
    expect(organizations.createInputs).toEqual([
      {
        name: "Alice Example's Organization",
        slug: "alice-examples-organization",
        userId: user.id,
      },
    ]);
    assert(organizations.creationCount === 1);
  });

  test("uses a deterministic fallback when another organization owns the preferred slug", async () => {
    const organizations = createMemoryUserOrganizations([
      occupiedOrganization("alice-examples-organization", 1),
    ]);

    const result = await ensureUserHasOrganization(user, organizations);

    assert(result.organization.slug === "alice-examples-organization-brisk-panda");
  });

  test("returns the concurrent organization that won a slug creation race", async () => {
    const concurrentOrganization = {
      id: "concurrent-org",
      slug: "alice-examples-organization",
      memberUserIds: [user.id],
    };
    const organizations = new MemoryUserOrganizations({
      organizations: [],
      creationError: null,
      concurrentOrganization,
    });

    const result = await ensureUserHasOrganization(user, organizations);

    expect(result).toEqual({
      created: false,
      organization: { id: "concurrent-org", slug: "alice-examples-organization" },
    });
    assert(organizations.creationCount === 1);
  });

  test("uses the final bounded fallback when earlier slug candidates are occupied", async () => {
    const slugs = allInitialOrganizationSlugs();
    const organizations = createMemoryUserOrganizations(
      slugs.slice(0, -1).map(occupiedOrganization),
    );

    const result = await ensureUserHasOrganization(user, organizations);

    expect(result.organization.slug).toBe(slugs.at(-1));
  });

  test("fails with user context after every bounded slug candidate is occupied", async () => {
    const organizations = createMemoryUserOrganizations(
      allInitialOrganizationSlugs().map(occupiedOrganization),
    );

    const creation = ensureUserHasOrganization(user, organizations);

    await expect(creation).rejects.toMatchObject({
      message: "Initial organization creation failed for user 'user123456789'.",
      cause: expect.objectContaining({
        message: "Initial organization slug allocation was exhausted.",
      }),
    });
    assert(organizations.creationCount === 0);
  });

  test("adds user context while preserving an unexpected creation failure", async () => {
    const storageError = new Error("Auth storage is unavailable.");
    const organizations = new MemoryUserOrganizations({
      organizations: [],
      creationError: storageError,
      concurrentOrganization: null,
    });

    const creation = ensureUserHasOrganization(user, organizations);

    await expect(creation).rejects.toThrow(
      "Initial organization creation failed for user 'user123456789'.",
    );
    await expect(creation).rejects.toMatchObject({
      cause: storageError,
      name: "UserOrganizationCreationError",
    } satisfies Partial<UserOrganizationCreationError>);
  });
});
