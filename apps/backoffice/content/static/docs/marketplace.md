# About the marketplace

> Status: outline · Documentation type: explanation

This document should explain how reusable automation packages are listed, versioned, published,
stored, browsed, and installed into a target scope.

## Planned sections

- Listings, owners, slugs, categories, and statuses.
- Draft and published versions.
- Artifact manifests and versioned files.
- Static marketplace entries shipped with the product.
- Publishing workflows and ordering constraints.
- Installation and ingestion into a target scope.
- Marketplace-managed automation routes and resources.
- Ownership, authorization, archival, and conflicts.
- Cursor-based listing and version pagination.

## Code references

- `apps/backoffice/app/fragno/marketplace/contracts.ts` — marketplace domain contracts.
- `apps/backoffice/app/fragno/marketplace/definition.ts` — listing and version services.
- `apps/backoffice/app/fragno/marketplace/schema.ts` — persisted marketplace records.
- `apps/backoffice/app/fragno/marketplace/artifacts.ts` — artifact paths and file preparation.
- `apps/backoffice/app/fragno/marketplace/static-entries.ts` — product-owned listings.
- `apps/backoffice/app/fragno/automation/marketplace-publish-workflow.ts` — publication workflow.
- `apps/backoffice/app/fragno/automation/marketplace-ingest-workflow.ts` — installation workflow.
- `apps/backoffice/app/fragno/automation/marketplace-ingestion-files.ts` — installed file handling.
- `apps/backoffice/app/routes/backoffice/marketplace/` — marketplace UI and actions.
- `apps/backoffice/content/marketplace/` — built-in marketplace content and examples.
