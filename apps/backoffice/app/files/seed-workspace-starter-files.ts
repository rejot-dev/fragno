import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createSystemFilesContext } from "@/files";
import { GENERAL_SKILL_CONTENT } from "@/files/content/skills";
import { WORKSPACE_STARTER_AUTOMATION_CONTENT } from "@/files/content/starter-automations";
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
  const fs = createUploadFileSystem(
    createSystemFilesContext({
      orgId,
      objects,
      uploadConfig,
      uploadRuntime: {
        baseUrl: "https://files.internal",
        fetch: async (input) =>
          uploadDo.fetch(input instanceof Request ? input : new Request(input)),
      },
    }),
    { mountPoint: "/workspace", provider },
  );

  const starterContent = {
    "AGENTS.md": `# Workspace guidance\n\nThis is the editable organisation workspace. User-owned automations live in \`/workspace/automations/\` and may be changed freely.\n`,
    "README.md": `# Workspace starter content\n\nThis editable workspace contains starter automation content and scratch areas.\n`,
    "input/notes.md": `# Notes\n\nUse this file for requirements, TODOs, links, and rough context before handing work to Pi or a Sandbox runtime.\n`,
    "prompts/task.md": `# Task prompt\n\nDescribe the task you want to work on here.\n`,
    "output/.gitkeep": "",
    ...WORKSPACE_STARTER_AUTOMATION_CONTENT,
    ...GENERAL_SKILL_CONTENT,
  };

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
