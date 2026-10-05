import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import type { StaticFileArtifactsLoader } from "@/files/content/static";
import {
  codemodeTypeFilesToStaticArtifacts,
  CODEMODE_MCP_SOURCE_DTS_PATH,
  createMcpCodemodeSourceTypeFile,
  type CodemodeTypeFile,
} from "@/fragno/codemode/codemode-type-files";
import { createMcpCodemodeServers } from "@/fragno/codemode/mcp-codemode-tools";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { mcpPublicAddress } from "@/fragno/scoped-public-fragment-routes";

export type CodemodeStaticArtifactsResult = {
  path: typeof CODEMODE_MCP_SOURCE_DTS_PATH;
  files: CodemodeTypeFile[];
  artifacts: Record<string, string>;
};

type CreateCodemodeStaticArtifactsInput = {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  execution: BackofficeExecutionContext;
};

/** Resolves the organization-specific MCP declaration layered over build-generated provider files. */
export async function createCodemodeStaticArtifacts({
  objects,
  config,
  execution,
}: CreateCodemodeStaticArtifactsInput): Promise<CodemodeStaticArtifactsResult> {
  if (execution.scope.kind !== "org" && execution.scope.kind !== "project") {
    throw new Error("MCP static artifacts require an organization or project scope.");
  }
  const orgId = execution.scope.orgId;
  const mcpServers = await createMcpRuntime(
    authorizedBackofficeObjectHttp(objects.mcp.for(execution.scope).http, execution),
    async () => {
      const organization = (await objects.auth.singleton().commands.getAllOrganizations()).find(
        ({ id }) => id === orgId,
      );
      if (!organization) {
        throw new Error(`Organization '${orgId}' could not be found.`);
      }
      return mcpPublicAddress(
        config.docsPublicBaseUrl,
        backofficeRouteScopeSinglePathSegment({ kind: "org", orgSlug: organization.slug }),
      );
    },
  )
    .listServers()
    .then(({ servers }) => createMcpCodemodeServers(servers))
    .catch((error: unknown) => {
      // Static declarations must not reveal servers to an execution without MCP read authority.
      if (isBackofficeForbiddenError(error) && error.reason !== "authority-unavailable") {
        return [];
      }
      throw error;
    });
  const files = [createMcpCodemodeSourceTypeFile(mcpServers)];

  return {
    path: CODEMODE_MCP_SOURCE_DTS_PATH,
    files,
    artifacts: codemodeTypeFilesToStaticArtifacts(files),
  };
}

export function createCodemodeStaticArtifactsResolver({
  objects,
  config,
  execution,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  execution: BackofficeExecutionContext;
}): StaticFileArtifactsLoader {
  if (execution.scope.kind === "user" || execution.scope.kind === "system") {
    return async () => ({});
  }

  return async () =>
    (
      await createCodemodeStaticArtifacts({
        objects,
        config,
        execution,
      })
    ).artifacts;
}
