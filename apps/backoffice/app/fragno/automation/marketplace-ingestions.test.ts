import { describe, expect, test, vi, assert } from "vitest";

import type { MarketplaceArtifactManifest } from "@/fragno/marketplace/contracts";

import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  MarketplaceIngestionArtifactUnavailableError,
  MarketplaceIngestionTargetAccessError,
  resolveMarketplaceIngestionArtifactVersion,
} from "./marketplace-ingestions";

const publishedManifest: MarketplaceArtifactManifest = {
  listingId: "system:telegram-test-command",
  slug: "telegram-test-command",
  listingStatus: "published",
  uploadName: "marketplace-system-telegram-test-command",
  versions: ["1.1.0", "1.0.0"],
};

describe("marketplace ingestion request rules", () => {
  test("rejects organization-owned targets from another organization before access checks", async () => {
    const projectExists = vi.fn(async () => true);
    const organizationHasMember = vi.fn(async () => true);

    expect(() =>
      assertMarketplaceIngestionTargetBelongsToOrganization({
        organizationId: "org-1",
        targetScope: { kind: "project", orgId: "org-2", projectId: "project-1" },
      }),
    ).toThrow(
      new MarketplaceIngestionTargetAccessError(
        "Marketplace ingestion target belongs to another organization.",
      ),
    );

    await expect(
      assertMarketplaceIngestionTargetAccessible({
        organizationId: "org-1",
        targetScope: { kind: "project", orgId: "org-2", projectId: "project-1" },
        projectExists,
        organizationHasMember,
      }),
    ).rejects.toThrow("Marketplace ingestion target belongs to another organization.");
    expect(projectExists).not.toHaveBeenCalled();
    expect(organizationHasMember).not.toHaveBeenCalled();
  });

  test("checks project existence and organization membership for their target kinds", async () => {
    await expect(
      assertMarketplaceIngestionTargetAccessible({
        organizationId: "org-1",
        targetScope: { kind: "project", orgId: "org-1", projectId: "missing-project" },
        projectExists: async () => false,
        organizationHasMember: async () => true,
      }),
    ).rejects.toThrow("Marketplace ingestion project target was not found.");

    await expect(
      assertMarketplaceIngestionTargetAccessible({
        organizationId: "org-1",
        targetScope: { kind: "user", userId: "former-member" },
        projectExists: async () => true,
        organizationHasMember: async () => false,
      }),
    ).rejects.toThrow("Marketplace ingestion user target is not a member of the organization.");
  });

  test("resolves latest and explicitly requested published artifact versions", () => {
    assert(
      resolveMarketplaceIngestionArtifactVersion(publishedManifest, undefined).version === "1.1.0",
    );
    assert(
      resolveMarketplaceIngestionArtifactVersion(publishedManifest, "1.0.0").version === "1.0.0",
    );
  });

  test("rejects unavailable marketplace artifacts", () => {
    expect(() => resolveMarketplaceIngestionArtifactVersion(null, undefined)).toThrow(
      new MarketplaceIngestionArtifactUnavailableError("Marketplace listing is not published."),
    );
    expect(() => resolveMarketplaceIngestionArtifactVersion(publishedManifest, "2.0.0")).toThrow(
      "Marketplace version '2.0.0' is not available.",
    );
  });
});
