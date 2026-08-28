import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import type { StaticFileArtifactsResolver } from "@/files/types";
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
  orgId: string;
};

/** Resolves the organization-specific MCP declaration layered over build-generated provider files. */
export async function createCodemodeStaticArtifacts({
  objects,
  config,
  orgId,
}: CreateCodemodeStaticArtifactsInput): Promise<CodemodeStaticArtifactsResult> {
  const mcpServers = await createMcpRuntime(objects.mcp.forOrg(orgId).http, async () => {
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
  })
    .listServers()
    .then(({ servers }) => createMcpCodemodeServers(servers));
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
}): StaticFileArtifactsResolver {
  if (execution.scope.kind === "user" || execution.scope.kind === "system") {
    return async () => ({});
  }

  const orgId = execution.scope.orgId;
  return async () =>
    (
      await createCodemodeStaticArtifacts({
        objects,
        config,
        orgId,
      })
    ).artifacts;
}
