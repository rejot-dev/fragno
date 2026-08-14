import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  createFragnoOutboxCoordinator,
  type FragnoOutboxCatchUpProgress,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeRoutePath,
  backofficeContextScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";

import { automationFragmentSchema } from "../schema";

export type AutomationCollectionSource = {
  scope: BackofficeContextScope;
  adapterIdentity: string;
};

export type AutomationCollectionSourceDescription = {
  resourceKey: string;
  baseUrl: string;
  internalUrl: string;
};

type SharedAutomationsCoordinator = FragnoOutboxCoordinator<
  readonly [typeof automationFragmentSchema, typeof workflowsSchema]
>;

export type AutomationBrowserCollections = ReturnType<typeof createAutomationBrowserCollections>;

export type AutomationBrowserDatabase = {
  coordinator: SharedAutomationsCoordinator;
  collections: AutomationBrowserCollections;
};

export function describeAutomationCollectionSource(
  source: AutomationCollectionSource,
): AutomationCollectionSourceDescription {
  const scopeKey = backofficeContextScopeSinglePathSegment(source.scope);
  const baseUrl = `/api/automations-scoped/${backofficeContextScopeRoutePath(source.scope)}`;

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl,
    internalUrl: `${baseUrl}/_internal`,
  };
}

const resources = new Map<string, Promise<AutomationBrowserDatabase>>();
const catchUpProgress = new Map<string, FragnoOutboxCatchUpProgress>();
const catchUpProgressListeners = new Map<string, Set<() => void>>();

export function getAutomationCatchUpProgress(
  resourceKey: string,
): FragnoOutboxCatchUpProgress | null {
  return catchUpProgress.get(resourceKey) ?? null;
}

export function subscribeAutomationCatchUpProgress(
  resourceKey: string,
  listener: () => void,
): () => void {
  const listeners = catchUpProgressListeners.get(resourceKey) ?? new Set();
  listeners.add(listener);
  catchUpProgressListeners.set(resourceKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      catchUpProgressListeners.delete(resourceKey);
    }
  };
}

function publishAutomationCatchUpProgress(
  resourceKey: string,
  progress: FragnoOutboxCatchUpProgress,
): void {
  catchUpProgress.set(resourceKey, progress);
  for (const listener of catchUpProgressListeners.get(resourceKey) ?? []) {
    listener();
  }
}

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
    fetch: (input, init) => globalThis.fetch(input, init),
    schemas: [automationFragmentSchema, workflowsSchema] as const,
    onCatchUpProgress(progress) {
      publishAutomationCatchUpProgress(description.resourceKey, progress);
    },
  });
  const collections = createAutomationBrowserCollections(coordinator);

  try {
    await coordinator.preload();
    return { coordinator, collections };
  } catch (error) {
    await coordinator.cleanup().catch(() => {});
    throw error;
  }
}

function createAutomationBrowserCollections(coordinator: SharedAutomationsCoordinator) {
  return {
    kvStore: coordinator.collection(automationFragmentSchema, "kv_store"),
    sandboxInstances: coordinator.collection(automationFragmentSchema, "sandbox_instance"),
    routes: coordinator.collection(automationFragmentSchema, "automation_route"),
    routeScheduleStates: coordinator.collection(
      automationFragmentSchema,
      "automation_route_schedule_state",
    ),
    events: coordinator.collection(automationFragmentSchema, "automation_event"),
    marketplaceIngestions: coordinator.collection(
      automationFragmentSchema,
      "marketplace_ingestion",
    ),
    eventDefinitions: coordinator.collection(
      automationFragmentSchema,
      "automation_event_definition",
    ),
    externalIdentityBindings: coordinator.collection(
      automationFragmentSchema,
      "external_identity_binding",
    ),
    workflowInstances: coordinator.collection(workflowsSchema, "workflow_instance"),
    workflowSteps: coordinator.collection(workflowsSchema, "workflow_step"),
    workflowEvents: coordinator.collection(workflowsSchema, "workflow_event"),
    workflowStepEmissions: coordinator.collection(workflowsSchema, "workflow_step_emission", {
      rowUpdateMode: "full",
      skipMissingTruncateDeletes: true,
    }),
  };
}
