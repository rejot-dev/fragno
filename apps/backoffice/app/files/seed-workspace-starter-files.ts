import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createSystemFilesContext } from "@/files";
import { WORKSPACE_STARTER_CONTENT } from "@/files/content/starter";
import { createUploadFileSystem } from "@/files/contributors/upload";
import { FileSystemError } from "@/files/fs-errors";
import type { IFileSystem } from "@/files/interface";

const fileExists = async (fs: IFileSystem, path: string) => {
  try {
    await fs.readFileBuffer(path);
    return true;
  } catch (error) {
    if (error instanceof FileSystemError && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

export type WorkspaceStarterFilesSeedOutput = {
  provider: string;
  force: boolean;
  created: string[];
  overwritten: string[];
  skipped: string[];
};

export const seedWorkspaceStarterFiles = async ({
  objects,
  orgId,
  force = false,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
  force?: boolean;
}): Promise<WorkspaceStarterFilesSeedOutput> => {
  const uploadDo = objects.upload.forOrg(orgId);
  const uploadConfig = await uploadDo.getAdminConfig();
  const provider = uploadConfig.defaultProvider ?? "database";
  const fs = createUploadFileSystem(createSystemFilesContext({ orgId, objects }), {
    mountPoint: "/workspace",
    provider,
  });

  const starterContent = WORKSPACE_STARTER_CONTENT;

  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, content] of Object.entries(starterContent)) {
    const normalizedPath = relativePath.replace(/^\/+/, "");
    const path = normalizedPath.startsWith("workspace/")
      ? `/${normalizedPath}`
      : `/workspace/${normalizedPath}`;
    const exists = await fileExists(fs, path);

    if (exists && !force) {
      skipped.push(path);
      continue;
    }

    await fs.writeFile(path, content);
    (exists ? overwritten : created).push(path);
  }

  return { provider, force, created, overwritten, skipped };
};
