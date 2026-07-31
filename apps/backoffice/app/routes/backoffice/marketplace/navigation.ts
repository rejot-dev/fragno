import { z } from "zod";

import { marketplaceListingIdSchema } from "@/fragno/marketplace/contracts";

import { marketplaceScopeTabPath, type MarketplaceUiScope } from "./scope";

const decodeMarketplaceListingRef = (listingRef: string): string => {
  if (!/^[0-9A-Za-z_-]+$/u.test(listingRef) || listingRef.length % 4 === 1) {
    throw new Error("Marketplace listing reference is invalid.");
  }

  const base64 = listingRef.replaceAll("-", "+").replaceAll("_", "/");
  const paddedBase64 = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return typeof Buffer !== "undefined"
    ? Buffer.from(paddedBase64, "base64").toString("utf-8")
    : atob(paddedBase64);
};

export const marketplaceListingRefSchema = z
  .string()
  .trim()
  .min(1)
  .transform((listingRef, context) => {
    try {
      return decodeMarketplaceListingRef(listingRef);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Use a valid marketplace listing reference.",
      });
      return z.NEVER;
    }
  })
  .pipe(marketplaceListingIdSchema);

export const marketplaceListingRef = (listingId: string): string => {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(listingId, "utf-8").toString("base64")
      : btoa(listingId);
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const marketplaceListingPath = (listingId: string, scope: MarketplaceUiScope): string =>
  `${marketplaceScopeTabPath(scope, "marketplace")}/${marketplaceListingRef(listingId)}`;

export function buildArtifactVersionPath(
  pathname: string,
  currentSearch: string,
  currentVersion: string,
  nextVersion: string,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("artifactVersion", nextVersion);
  const currentTab = search.get("artifactTab");
  if (currentTab !== "files" && currentTab !== "workflows") {
    search.set("artifactTab", "files");
  }

  const selectedPath = search.get("artifactPath")?.trim();
  const currentVersionRoot = `/artifact/${currentVersion}`;
  if (selectedPath === currentVersionRoot || selectedPath?.startsWith(`${currentVersionRoot}/`)) {
    search.set(
      "artifactPath",
      `/artifact/${nextVersion}${selectedPath.slice(currentVersionRoot.length)}`,
    );
  }

  return `${pathname}?${search}`;
}

export const marketplaceListingManagePath = ({
  listingId,
  organizationId,
  result,
}: {
  listingId: string;
  organizationId: string;
  result?: Readonly<Record<string, string>>;
}): string => {
  const search = new URLSearchParams({ organizationId });
  for (const [name, value] of Object.entries(result ?? {})) {
    search.set(name, value);
  }
  return `/backoffice/marketplace/${marketplaceListingRef(listingId)}/manage?${search.toString()}`;
};
