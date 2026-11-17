import type { AutomationActor } from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { CodemodeToolResult } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { encodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import { createCodemodeDispatchers } from "@fragno-dev/codemode/host/codemode-tool-dispatcher";
import { resolveProvider } from "@fragno-dev/codemode/runtime-api";

import {
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import {
  createBackofficeCodemodeProviders,
  type BackofficeRuntimeToolFamily,
} from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { siteInitiator } from "./site-events";

/** The runtime tool families as a site's Worker sees them: only the tools sites may call. */
const SITE_TOOL_FAMILIES: readonly BackofficeRuntimeToolFamily[] = runtimeToolFamilies.flatMap(
  (family) => {
    const tools = family.tools.filter((tool) => tool.callableFromSites);
    return tools.length === 0 ? [] : [{ ...family, tools }];
  },
);

/** Each namespace a site calls tools in, which its Worker has as a global, as programs do. */
export const SITE_TOOL_NAMESPACES: readonly string[] = [
  ...new Set(SITE_TOOL_FAMILIES.map((family) => family.namespace)),
];

/**
 * What whoever builds a site must hold, so that the agent who builds it cannot leave it calling
 * tools its own grants do not cover, as calls run as the person it acts for.
 */
export const SITE_TOOL_PERMISSIONS: readonly BackofficePermissionRequirement[] = [
  ...new Map(
    SITE_TOOL_FAMILIES.flatMap((family) => family.tools)
      .flatMap((tool) => tool.requiredPermissions)
      .map((permission) => [`${permission.namespace}.${permission.permission}`, permission]),
  ).values(),
];

const SITE_TOOL_NAMES = SITE_TOOL_FAMILIES.flatMap((family) =>
  family.tools.map((tool) => `${tool.namespace}.${tool.name}`),
);

/** Whom a site's tool calls act for: the principal of the build it serves, null for the system. */
export type SiteToolsProps = {
  scope: BackofficeContextScope;
  sitePath: string;
  builder: AutomationActor<"principal"> | null;
};

/**
 * Calls a tool for a site's Worker, as codemode calls it for a program: as whoever built the site,
 * with their permissions as they are now, so a builder who loses a permission takes it from the
 * site. The site initiates the call.
 */
export async function callSiteTool({
  runtime,
  props,
  namespace,
  tool,
  args,
}: {
  runtime: BackofficeRuntimeServices;
  props: SiteToolsProps;
  namespace: string;
  tool: string;
  args: unknown[];
}): Promise<CodemodeToolResult> {
  const name = `${namespace}.${tool}`;
  if (!SITE_TOOL_NAMES.includes(name)) {
    return {
      status: "error",
      error: encodeCodemodeError(
        new Error(`Sites cannot call ${name}; they call ${SITE_TOOL_NAMES.join(", ")}.`),
      ),
    };
  }
  const execution = siteToolExecution(props);
  const context = createBackofficeToolContext(
    createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution,
      emitter: { kind: "caller" },
    }),
  );
  const dispatchers = createCodemodeDispatchers(
    createBackofficeCodemodeProviders({ families: SITE_TOOL_FAMILIES, context }).map(
      resolveProvider,
    ),
  );
  if ("error" in dispatchers) {
    throw new Error(dispatchers.error);
  }
  return await dispatchers.dispatchers[namespace].call(tool, args);
}

/** A site the system built acts as the system; one a person built acts for them. */
function siteToolExecution({
  scope,
  sitePath,
  builder,
}: SiteToolsProps): BackofficeExecutionContext {
  if (builder === null) {
    return createBackofficeSystemExecution(scope);
  }
  return {
    kind: "deferred",
    scope,
    scopeRestriction: null,
    actors: { initiator: siteInitiator(sitePath), principal: builder, delegation: [] },
  };
}
