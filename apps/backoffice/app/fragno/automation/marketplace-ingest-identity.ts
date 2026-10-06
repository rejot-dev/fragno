import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
} from "@/fragno/marketplace/contracts";
import { sha256Hex } from "@/lib/crypto";

export const MARKETPLACE_INGEST_WORKFLOW_NAME = "marketplace-ingest";

export const marketplaceInstallationWorkflowInstanceId = (ingestionWorkflowInstanceId: string) =>
  `${ingestionWorkflowInstanceId}:installation`;

export const buildMarketplaceIngestionWorkflowInstanceId = async (input: {
  targetScope: BackofficeRoutableScope;
  installationRoot: string;
  listingId: string;
  version: string;
}) =>
  `marketplace-ingest-${await sha256Hex(
    new TextEncoder().encode(
      `${backofficeScopeSinglePathSegment(input.targetScope)}\0${input.installationRoot}\0${marketplaceListingIdSchema.parse(input.listingId)}\0${marketplaceVersionSchema.parse(input.version)}`,
    ),
  )}`;
