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

export const marketplaceIngestionTargetScopeKey = (scope: BackofficeRoutableScope): string =>
  backofficeScopeSinglePathSegment(scope);

export const marketplaceInstallationWorkflowInstanceId = (ingestionWorkflowInstanceId: string) =>
  `${ingestionWorkflowInstanceId}:installation`;

export const buildMarketplaceIngestionWorkflowInstanceId = async (input: {
  targetScope: BackofficeRoutableScope;
  listingId: string;
  version: string;
}) =>
  `marketplace-ingest-${await sha256Hex(
    new TextEncoder().encode(
      `${marketplaceIngestionTargetScopeKey(input.targetScope)}\0${marketplaceListingIdSchema.parse(input.listingId)}\0${marketplaceVersionSchema.parse(input.version)}`,
    ),
  )}`;
