import { marketplaceListingIdSchema } from "@fragno-dev/backoffice-api/v0/marketplace";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

import { marketplaceListingRouteSchema } from "./navigation";

/** The publisher in a listing URL is independent of the browsing or installation workspace. */
export async function resolveMarketplaceListingRoute(
  objects: BackofficeObjectRegistry,
  params: Readonly<Record<string, string | undefined>>,
): Promise<{ listingId: string; listingRef: string }> {
  const route = marketplaceListingRouteSchema.safeParse(params);
  if (!route.success) {
    throw new Response("Not Found", { status: 404 });
  }
  const { publisher, packageSlug } = route.data;
  if (publisher.startsWith("@")) {
    const organization = await objects.auth
      .singleton()
      .commands.getOrganizationBySlug(publisher.slice(1));
    if (!organization) {
      throw new Response("Not Found", { status: 404 });
    }
    const listingId = marketplaceListingId({
      ownerScope: { kind: "org", orgId: organization.id },
      slug: packageSlug,
    });
    if (!marketplaceListingIdSchema.safeParse(listingId).success) {
      throw new Response("Not Found", { status: 404 });
    }
    return { listingId, listingRef: `${publisher}/${packageSlug}` };
  }
  const listingId = marketplaceListingIdSchema.safeParse(`${publisher}#${packageSlug}`);
  if (!listingId.success) {
    throw new Response("Not Found", { status: 404 });
  }
  return {
    listingId: listingId.data,
    listingRef: `${encodeURIComponent(publisher)}/${packageSlug}`,
  };
}

/** Resolve current organization slugs once per publisher, not once per card. */
export async function loadMarketplaceListingRefs(
  objects: BackofficeObjectRegistry,
  listingIds: readonly string[],
): Promise<Record<string, string>> {
  const publishers = new Map<string, Promise<string>>();
  return Object.fromEntries(
    await Promise.all(
      listingIds.map(async (listingId) => {
        const separator = listingId.lastIndexOf("#");
        const ownerKey = listingId.slice(0, separator);
        const slug = listingId.slice(separator + 1);
        let publisher = publishers.get(ownerKey);
        if (!publisher) {
          publisher = ownerKey.startsWith("org:")
            ? objects.auth
                .singleton()
                .commands.getOrganization({
                  organizationId: decodeURIComponent(ownerKey.slice(4)),
                })
                .then((organization) => {
                  if (!organization) {
                    throw new Response("Publisher organization was not found.", { status: 404 });
                  }
                  return `@${organization.slug}`;
                })
            : Promise.resolve(encodeURIComponent(ownerKey));
          publishers.set(ownerKey, publisher);
        }
        return [listingId, `${await publisher}/${slug}`] as const;
      }),
    ),
  );
}
