import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  createFragnoOutboxCoordinator,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import { backofficeFetch } from "@/fragno/auth/browser-auth.client";

import { automationFragmentSchema } from "../schema";
import { createAutomationCollections, type AutomationCollections } from "./collections";

export type AutomationCollectionSource<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> = {
  resolvedScope: BackofficeResolvedScope<TOrganization>;
  adapterIdentity: string;
};

type AutomationCollectionSourceDescription = {
  resourceKey: string;
  baseUrl: string;
  internalUrl: string;
};

type SharedAutomationsCoordinator = FragnoOutboxCoordinator<
  readonly [typeof automationFragmentSchema, typeof workflowsSchema]
>;

export type AutomationBrowserCollections = AutomationCollections;

export type AutomationBrowserDatabase = {
  coordinator: SharedAutomationsCoordinator;
  collections: AutomationBrowserCollections;
};

export function describeAutomationCollectionSource(
  source: AutomationCollectionSource,
): AutomationCollectionSourceDescription {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(source.resolvedScope);
  const scopeKey = backofficeScopePathSegment(runtimeScope);
  const baseUrl = `/api/automations-scoped/${backofficeContextScopeRoutePath(runtimeScope)}`;

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl,
    internalUrl: `${baseUrl}/_internal`,
  };
}

const resources = new Map<string, Promise<AutomationBrowserDatabase>>();

/** One browser database for every scope-specific Automations Durable Object and its shared outbox. */
export function getAutomationBrowserDatabase(
  source: AutomationCollectionSource,
): Promise<AutomationBrowserDatabase> {
  const description = describeAutomationCollectionSource(source);
  const existing = resources.get(description.resourceKey);
  if (existing) {
    return existing;
  }

  // React Suspense requires the same promise for every render, including after rejection. Removing
  // a failed resource here would make the next render open another coordinator and retry the
  // internal description request forever instead of propagating the failure to an error boundary.
  const resource = openAutomationBrowserDatabase(description);
  resources.set(description.resourceKey, resource);
  return resource;
}

async function openAutomationBrowserDatabase(
  description: AutomationCollectionSourceDescription,
): Promise<AutomationBrowserDatabase> {
  const coordinator = await createFragnoOutboxCoordinator({
    baseUrl: description.baseUrl,
    fetch: backofficeFetch,
    schemas: [automationFragmentSchema, workflowsSchema] as const,
  });
  const collections = createAutomationCollections(coordinator);

  try {
    await coordinator.preload();
    return { coordinator, collections };
  } catch (error) {
    await coordinator.cleanup().catch(() => {});
    throw error;
  }
}
