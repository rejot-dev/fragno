import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import {
  fetchAutomationIdentityBindings,
  fetchAutomationScenarios,
  fetchAutomationScripts,
  fetchAutomationTriggerBindings,
  toExternalId,
} from "./data";
import type {
  AutomationIdentityItem,
  AutomationScenarioItem,
  AutomationScriptItem,
  AutomationTriggerItem,
} from "./shared";
import {
  AutomationErrorBoundary,
  AutomationHeader,
  AutomationTabs,
  type AutomationTab,
} from "./shared";

const normalizeScripts = (
  scripts: Awaited<ReturnType<typeof fetchAutomationScripts>>["scripts"],
): AutomationScriptItem[] => {
  return scripts
    .map((script) => ({
      id: script.id,
      key: script.key,
      name: script.name,
      engine: script.engine,
      script: script.body,
      path: script.path,
      absolutePath: script.absolutePath,
      version: script.version,
      bindingIds: script.bindingIds,
      bindingCount: script.bindingCount,
      enabledBindingCount: script.enabledBindingCount,
      enabled: script.enabled,
    }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
};

const normalizeTriggerBindings = (
  bindings: Awaited<ReturnType<typeof fetchAutomationTriggerBindings>>["bindings"],
): AutomationTriggerItem[] => {
  return bindings
    .map((binding) => ({
      id: binding.id,
      source: binding.source,
      eventType: binding.eventType,
      scriptId: binding.scriptId,
      scriptKey: binding.scriptKey,
      scriptName: binding.scriptName,
      scriptPath: binding.scriptPath,
      absoluteScriptPath: binding.absoluteScriptPath,
      scriptVersion: binding.scriptVersion,
      scriptEngine: binding.scriptEngine,
      scriptEnv: binding.scriptEnv,
      enabled: binding.enabled,
      triggerOrder: binding.triggerOrder,
    }))
    .sort((left, right) => {
      const sourceOrder = left.source.localeCompare(right.source);
      if (sourceOrder !== 0) {
        return sourceOrder;
      }

      const eventOrder = left.eventType.localeCompare(right.eventType);
      if (eventOrder !== 0) {
        return eventOrder;
      }

      return left.id.localeCompare(right.id);
    });
};

const normalizeIdentityBindings = (
  storedBindings: Awaited<ReturnType<typeof fetchAutomationIdentityBindings>>["identityBindings"],
) => {
  const bindings: AutomationIdentityItem[] = storedBindings.map((binding, index) => ({
    id: toExternalId(binding.id) || `identity-binding-${index}`,
    source: binding.source?.trim() || "unknown",
    key: binding.key?.trim() || "—",
    value: binding.value?.trim() || "—",
    description: binding.description?.trim() || null,
    status: binding.status?.trim() || "linked",
    linkedAt: binding.linkedAt ?? null,
    createdAt: binding.createdAt ?? null,
    updatedAt: binding.updatedAt ?? null,
  }));

  return bindings.sort((left, right) => {
    const leftTime = left.linkedAt ? new Date(left.linkedAt).getTime() : 0;
    const rightTime = right.linkedAt ? new Date(right.linkedAt).getTime() : 0;
    return rightTime - leftTime;
  });
};

const normalizeScenarios = (
  scenarios: Awaited<ReturnType<typeof fetchAutomationScenarios>>["scenarios"],
): AutomationScenarioItem[] => {
  return scenarios
    .map((scenario, index) => ({
      id: scenario.id?.trim() || `automation-scenario-${index}`,
      path: scenario.path?.trim() || "",
      relativePath: scenario.relativePath?.trim() || scenario.fileName?.trim() || "",
      fileName: scenario.fileName?.trim() || scenario.relativePath?.trim() || "scenario.json",
      name: scenario.name?.trim() || scenario.fileName?.trim() || `Scenario ${index + 1}`,
      description: scenario.description?.trim() || undefined,
      env:
        scenario.env && typeof scenario.env === "object"
          ? Object.fromEntries(
              Object.entries(scenario.env).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string",
              ),
            )
          : {},
      initialState: scenario.initialState,
      commandMocks: scenario.commandMocks,
      stepCount:
        typeof scenario.stepCount === "number" && Number.isFinite(scenario.stepCount)
          ? scenario.stepCount
          : 0,
      relatedBindingIds: Array.isArray(scenario.relatedBindingIds)
        ? scenario.relatedBindingIds.filter((value): value is string => typeof value === "string")
        : [],
      relatedScriptIds: Array.isArray(scenario.relatedScriptIds)
        ? scenario.relatedScriptIds.filter((value): value is string => typeof value === "string")
        : [],
      relatedScriptKeys: Array.isArray(scenario.relatedScriptKeys)
        ? scenario.relatedScriptKeys.filter((value): value is string => typeof value === "string")
        : [],
      relatedScriptPaths: Array.isArray(scenario.relatedScriptPaths)
        ? scenario.relatedScriptPaths.filter((value): value is string => typeof value === "string")
        : [],
      sources: Array.isArray(scenario.sources)
        ? scenario.sources.filter((value): value is string => typeof value === "string")
        : [],
      eventTypes: Array.isArray(scenario.eventTypes)
        ? scenario.eventTypes.filter((value): value is string => typeof value === "string")
        : [],
      steps: Array.isArray(scenario.steps)
        ? scenario.steps.map((step, stepIndex) => {
            const rawStep = step as Record<string, unknown>;
            const rawEvent =
              rawStep.event && typeof rawStep.event === "object"
                ? (rawStep.event as Record<string, unknown>)
                : null;

            return {
              index:
                typeof rawStep.index === "number" && Number.isFinite(rawStep.index)
                  ? rawStep.index
                  : stepIndex,
              id:
                typeof rawStep.id === "string" && rawStep.id.trim()
                  ? rawStep.id
                  : `step-${stepIndex + 1}`,
              title:
                typeof rawStep.title === "string" && rawStep.title.trim()
                  ? rawStep.title
                  : undefined,
              event: rawEvent
                ? {
                    id:
                      typeof rawEvent.id === "string" && rawEvent.id.trim()
                        ? rawEvent.id
                        : `event-${stepIndex + 1}`,
                    orgId:
                      typeof rawEvent.orgId === "string" && rawEvent.orgId.trim()
                        ? rawEvent.orgId
                        : undefined,
                    source:
                      typeof rawEvent.source === "string" && rawEvent.source.trim()
                        ? rawEvent.source
                        : "unknown",
                    eventType:
                      typeof rawEvent.eventType === "string" && rawEvent.eventType.trim()
                        ? rawEvent.eventType
                        : "unknown",
                    occurredAt:
                      typeof rawEvent.occurredAt === "string" && rawEvent.occurredAt.trim()
                        ? rawEvent.occurredAt
                        : "",
                    payload:
                      rawEvent.payload && typeof rawEvent.payload === "object"
                        ? (rawEvent.payload as Record<string, unknown>)
                        : {},
                    actor:
                      rawEvent.actor && typeof rawEvent.actor === "object"
                        ? (rawEvent.actor as {
                            type?: string;
                            externalId?: string;
                            [key: string]: unknown;
                          })
                        : null,
                    subject:
                      rawEvent.subject && typeof rawEvent.subject === "object"
                        ? (rawEvent.subject as {
                            orgId?: string;
                            userId?: string;
                            [key: string]: unknown;
                          })
                        : null,
                  }
                : {
                    id: `event-${stepIndex + 1}`,
                    source: "unknown",
                    eventType: "unknown",
                    occurredAt: "",
                    payload: {},
                    actor: null,
                    subject: null,
                  },
              matchedBindingIds: Array.isArray(rawStep.matchedBindingIds)
                ? rawStep.matchedBindingIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              matchedScriptIds: Array.isArray(rawStep.matchedScriptIds)
                ? rawStep.matchedScriptIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              matchedScriptKeys: Array.isArray(rawStep.matchedScriptKeys)
                ? rawStep.matchedScriptKeys.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              matchedScriptPaths: Array.isArray(rawStep.matchedScriptPaths)
                ? rawStep.matchedScriptPaths.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
            };
          })
        : [],
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.relativePath.localeCompare(right.relativePath),
    );
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throwOrganisationNotFound(params.orgId);
  }

  const [scriptsResult, bindingsResult, identityResult, scenariosResult] = await Promise.all([
    fetchAutomationScripts(request, context, params.orgId),
    fetchAutomationTriggerBindings(request, context, params.orgId),
    fetchAutomationIdentityBindings(request, context, params.orgId),
    fetchAutomationScenarios(request, context, params.orgId),
  ]);

  const scripts = normalizeScripts(scriptsResult.scripts);
  const triggerBindings = normalizeTriggerBindings(bindingsResult.bindings);
  const identityBindings = normalizeIdentityBindings(identityResult.identityBindings);
  const scenarios = normalizeScenarios(scenariosResult.scenarios);

  return {
    orgId: params.orgId,
    organisation,
    scripts,
    triggerBindings,
    identityBindings,
    scenarios,
    scriptsError: scriptsResult.scriptsError,
    triggerBindingsError: bindingsResult.bindingsError,
    identityBindingsError: identityResult.identityBindingsError,
    scenariosError: scenariosResult.scenariosError,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const orgId = data?.orgId ?? "organisation";
  return [{ title: `Automations · ${orgId}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <AutomationErrorBoundary error={error} params={params} />;
}

export default function BackofficeOrganisationAutomationsLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const pathSegments = currentPath.split("/").filter(Boolean);

  let activeTab: AutomationTab = "scripts";
  if (pathSegments.includes("triggers")) {
    activeTab = "triggers";
  } else if (pathSegments.includes("identity")) {
    activeTab = "identity";
  }

  return (
    <div className="space-y-4">
      <AutomationHeader orgId={loaderData.orgId} organisationName={loaderData.organisation.name} />
      <AutomationTabs orgId={loaderData.orgId} activeTab={activeTab} />
      <Outlet context={loaderData} />
    </div>
  );
}
