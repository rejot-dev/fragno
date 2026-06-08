import type { DatabaseServiceContext } from "@fragno-dev/db";

import { authSchema } from "../schema";
import type { Organization } from "./types";
import { toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<{}>;

const mapOrganization = (organization: {
  id: unknown;
  name: string;
  slug: string;
  logoUrl: string | null;
  metadata: unknown;
  createdBy: unknown;
  organizationCreator?: { id?: unknown } | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): Organization => ({
  id: toExternalId(organization.id),
  name: organization.name,
  slug: organization.slug,
  logoUrl: organization.logoUrl ?? null,
  metadata: (organization.metadata ?? null) as Record<string, unknown> | null,
  createdBy: toExternalId(organization.organizationCreator?.id ?? organization.createdBy),
  createdAt: organization.createdAt,
  updatedAt: organization.updatedAt,
  deletedAt: organization.deletedAt ?? null,
});

export function createAdminOrganizationServices() {
  return {
    getAllOrganizations: function (this: AuthServiceContext) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.find("organization", (b) =>
            b
              .whereIndex("idx_organization_createdBy")
              .joinOne("organizationCreator", "user", (creator) =>
                creator.onIndex("primary", (eb) => eb("id", "=", eb.parent("createdBy"))),
              ),
          ),
        )
        .transformRetrieve(([organizations]) =>
          organizations
            .filter((organization) => organization.deletedAt == null)
            .map((organization) =>
              mapOrganization({
                id: organization.id,
                name: organization.name,
                slug: organization.slug,
                logoUrl: organization.logoUrl,
                metadata: organization.metadata,
                createdBy: organization.createdBy,
                organizationCreator: organization.organizationCreator ?? null,
                createdAt: organization.createdAt,
                updatedAt: organization.updatedAt,
                deletedAt: organization.deletedAt,
              }),
            ),
        )
        .build();
    },
  };
}
