import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createSystemFilesContext, type FileGroup, type FileSubject } from "@/files";
import { WORKSPACE_STARTER_CONTENT } from "@/files/content/starter";
import { createUploadFileSystem } from "@/files/contributors/upload";
import { FileSystemError } from "@/files/fs-errors";
import type { IFileSystem } from "@/files/interface";

const WORKSPACE_ROOT = "/workspace";
const WORKSPACE_STARTER_FILE_MODE = 0o664;
const WORKSPACE_STARTER_FOLDER_MODE = 0o775;

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

const toWorkspacePath = (relativePath: string) => {
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return normalizedPath.startsWith("workspace/")
    ? `/${normalizedPath}`
    : `${WORKSPACE_ROOT}/${normalizedPath}`;
};

const getParentDirectories = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  const directories: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    const directory = `/${segments.slice(0, index).join("/")}`;
    if (directory !== WORKSPACE_ROOT) {
      directories.push(directory);
    }
  }

  return directories;
};

const resetStarterNodePermissions = async ({
  fs,
  path,
  owner,
  group,
  mode,
}: {
  fs: IFileSystem;
  path: string;
  owner: FileSubject;
  group: FileGroup;
  mode: number;
}) => {
  await fs.chown?.(path, owner, group);
  await fs.chmod(path, mode);
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
  const fileContext = createSystemFilesContext({ orgId, objects });
  const fs = createUploadFileSystem(fileContext, {
    mountPoint: WORKSPACE_ROOT,
    provider,
  });

  const starterContent = WORKSPACE_STARTER_CONTENT;
  const workspaceOwner = fileContext.filePrincipal.subject;
  const workspaceGroup = fileContext.filePrincipal.primaryGroup;

  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  const starterPaths = Object.keys(starterContent).map(toWorkspacePath);
  const starterDirectories = Array.from(
    new Set(starterPaths.flatMap((path) => getParentDirectories(path))),
  ).sort((left, right) => left.localeCompare(right));

  if (force) {
    for (const directory of starterDirectories) {
      await fs.mkdir(directory, { recursive: true });
      await resetStarterNodePermissions({
        fs,
        path: directory,
        owner: workspaceOwner,
        group: workspaceGroup,
        mode: WORKSPACE_STARTER_FOLDER_MODE,
      });
    }
  }

  for (const [relativePath, content] of Object.entries(starterContent)) {
    const path = toWorkspacePath(relativePath);
    const exists = await fileExists(fs, path);

    if (exists && !force) {
      skipped.push(path);
      continue;
    }

    if (force && exists) {
      await fs.rm(path, { force: true });
    }

    await fs.writeFile(path, content);

    if (force) {
      await resetStarterNodePermissions({
        fs,
        path,
        owner: workspaceOwner,
        group: workspaceGroup,
        mode: WORKSPACE_STARTER_FILE_MODE,
      });
    }

    (exists ? overwritten : created).push(path);
  }

  return { provider, force, created, overwritten, skipped };
};
