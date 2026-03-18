import { Outlet } from "react-router";

import { getAuthMe } from "@/fragno/auth-server";
import { builtinAutomationBindings, builtinAutomationScripts } from "@/fragno/automation/builtins";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { throwOrganisationNotFound } from "../route-errors";
import type { Route } from "./+types/organisation-layout";
import {
  fetchAutomationIdentityBindings,
  fetchAutomationScripts,
  fetchAutomationTriggerBindings,
  toExternalId,
} from "./data";
import type { AutomationIdentityItem, AutomationScriptItem, AutomationTriggerItem } from "./shared";
import {
  AutomationErrorBoundary,
  AutomationHeader,
  AutomationTabs,
  type AutomationTab,
} from "./shared";

const toVersion = (value: unknown, fallback = 1) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
};

const compareKinds = (left: "builtin" | "custom", right: "builtin" | "custom") => {
  if (left === right) {
    return 0;
  }

  return left === "builtin" ? -1 : 1;
};

const normalizeScripts = (
  storedScripts: Awaited<ReturnType<typeof fetchAutomationScripts>>["scripts"],
) => {
  const builtins: AutomationScriptItem[] = builtinAutomationScripts.map((script) => ({
    id: `builtin:${script.key}@${script.version}`,
    key: script.key,
    name: script.name,
    engine: script.engine,
    script: script.script,
    version: script.version,
    enabled: script.enabled !== false,
    kind: "builtin",
    createdAt: null,
    updatedAt: null,
  }));

  const custom: AutomationScriptItem[] = storedScripts.map((script, index) => ({
    id: toExternalId(script.id) || `script-${index}`,
    key: script.key?.trim() || `script-${index}`,
    name: script.name?.trim() || script.key?.trim() || `Script ${index + 1}`,
    engine: script.engine?.trim() || "bash",
    script: script.script ?? "",
    version: toVersion(script.version),
    enabled: script.enabled !== false,
    kind: "custom",
    createdAt: script.createdAt ?? null,
    updatedAt: script.updatedAt ?? null,
  }));

  return [...builtins, ...custom].sort((left, right) => {
    const kindOrder = compareKinds(left.kind, right.kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }

    return left.name.localeCompare(right.name);
  });
};

const normalizeTriggerBindings = (
  storedBindings: Awaited<ReturnType<typeof fetchAutomationTriggerBindings>>["bindings"],
  scripts: AutomationScriptItem[],
) => {
  const scriptById = new Map(
    scripts.filter((script) => script.kind === "custom").map((script) => [script.id, script]),
  );
  const builtinScriptByKeyVersion = new Map(
    builtinAutomationScripts.map((script) => [`${script.key}@${script.version}`, script]),
  );

  const builtins: AutomationTriggerItem[] = builtinAutomationBindings.map((binding, index) => {
    const script = builtinScriptByKeyVersion.get(
      `${binding.scriptKey}@${binding.scriptVersion ?? 1}`,
    );

    return {
      id: `builtin-binding:${binding.source}:${binding.eventType}:${binding.scriptKey}:${index}`,
      source: binding.source,
      eventType: binding.eventType,
      scriptId: script ? `builtin:${script.key}@${script.version}` : binding.scriptKey,
      scriptKey: binding.scriptKey,
      scriptName: script?.name ?? binding.scriptKey,
      scriptVersion: script?.version ?? binding.scriptVersion ?? 1,
      enabled: binding.enabled !== false,
      kind: "builtin",
      createdAt: null,
      updatedAt: null,
    };
  });

  const custom: AutomationTriggerItem[] = storedBindings.map((binding, index) => {
    const scriptId = toExternalId(binding.scriptId);
    const script = scriptById.get(scriptId);

    return {
      id: toExternalId(binding.id) || `binding-${index}`,
      source: binding.source?.trim() || "unknown",
      eventType: binding.eventType?.trim() || "unknown",
      scriptId,
      scriptKey: script?.key ?? (scriptId || "unknown-script"),
      scriptName: script?.name ?? "Unknown script",
      scriptVersion: script?.version ?? null,
      enabled: binding.enabled !== false,
      kind: "custom",
      createdAt: binding.createdAt ?? null,
      updatedAt: binding.updatedAt ?? null,
    };
  });

  return [...builtins, ...custom].sort((left, right) => {
    const kindOrder = compareKinds(left.kind, right.kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }

    const sourceOrder = left.source.localeCompare(right.source);
    if (sourceOrder !== 0) {
      return sourceOrder;
    }

    return left.eventType.localeCompare(right.eventType);
  });
};

const normalizeIdentityBindings = (
  storedBindings: Awaited<ReturnType<typeof fetchAutomationIdentityBindings>>["identityBindings"],
) => {
  const bindings: AutomationIdentityItem[] = storedBindings.map((binding, index) => ({
    id: toExternalId(binding.id) || `identity-binding-${index}`,
    source: binding.source?.trim() || "unknown",
    externalActorId: binding.externalActorId?.trim() || "—",
    userId: binding.userId?.trim() || "—",
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

  const [scriptsResult, bindingsResult, identityResult] = await Promise.all([
    fetchAutomationScripts(request, context, params.orgId),
    fetchAutomationTriggerBindings(request, context, params.orgId),
    fetchAutomationIdentityBindings(request, context, params.orgId),
  ]);

  const scripts = normalizeScripts(scriptsResult.scripts);
  const triggerBindings = normalizeTriggerBindings(bindingsResult.bindings, scripts);
  const identityBindings = normalizeIdentityBindings(identityResult.identityBindings);

  return {
    orgId: params.orgId,
    organisation,
    scripts,
    triggerBindings,
    identityBindings,
    scriptsError: scriptsResult.scriptsError,
    triggerBindingsError: bindingsResult.bindingsError,
    identityBindingsError: identityResult.identityBindingsError,
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
