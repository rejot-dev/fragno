import { marketplaceInstallationRootSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { marketplaceVersionSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { buildMarketplacePackageTabPath } from "./package-tabs";

const marketplaceInstallationReferenceSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  installationRoot: marketplaceInstallationRootSchema,
  version: marketplaceVersionSchema,
});

/** The route supplies listing and destination scope; the URL preserves the release, folder, and coordinator. */
export type MarketplaceInstallationReference = z.output<
  typeof marketplaceInstallationReferenceSchema
>;

/** Validate a persisted installation reference before reconstructing its deterministic workflow ID. */
export function readMarketplaceInstallationReference(
  search: string,
): MarketplaceInstallationReference | null {
  const encoded = new URLSearchParams(search).get("installation");
  if (encoded === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Marketplace installation reference is invalid.");
  }
  const reference = marketplaceInstallationReferenceSchema.safeParse(value);
  if (!reference.success) {
    throw new Error("Marketplace installation reference is invalid.");
  }
  return reference.data;
}

/** Starting and dismissing installations update the URL without losing the selected package. */
export function buildMarketplaceInstallationPath(
  pathname: string,
  currentSearch: string,
  reference: MarketplaceInstallationReference | null,
): string {
  const search = new URLSearchParams(currentSearch);
  if (reference) {
    search.set(
      "installation",
      JSON.stringify({
        organizationId: reference.organizationId,
        installationRoot: reference.installationRoot,
        version: reference.version,
      }),
    );
    search.set("artifactVersion", reference.version);
  } else {
    search.delete("installation");
  }
  return buildMarketplacePackageTabPath(pathname, search.toString(), "install");
}
