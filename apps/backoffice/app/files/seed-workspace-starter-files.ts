import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { createBackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";

import { WORKSPACE_STARTER_CONTENT } from "./content/starter";

export type WorkspaceStarterFilesSeedOutput = {
  provider: string;
  force: boolean;
  created: string[];
  overwritten: string[];
  skipped: string[];
};

/** Seeds database-backed workspace files without layering product content over editable files. */
export async function seedWorkspaceStarterFiles({
  objects,
  scope,
  force = false,
}: {
  objects: BackofficeObjectRegistry;
  scope: BackofficeContextScope;
  force?: boolean;
}): Promise<WorkspaceStarterFilesSeedOutput> {
  const state = createBackofficeStateBackend({
    uploadObject: objects.upload.for(scope).http,
    staticFileCollection: createStaticFileCollection({}),
  });
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, content] of Object.entries(WORKSPACE_STARTER_CONTENT)) {
    const path = `/workspace/${relativePath.replace(/^\/+/, "").replace(/^workspace\//, "")}`;
    const exists = await state.exists(path);
    if (exists && !force) {
      skipped.push(path);
      continue;
    }
    if (typeof content === "string") {
      await state.writeFile(path, content);
    } else {
      await state.writeFileBytes(path, content);
    }
    (exists ? overwritten : created).push(path);
  }
  return { provider: UPLOAD_PROVIDER_DATABASE, force, created, overwritten, skipped };
}
