import { z } from "zod";

import { GENERAL_SKILL_CONTENT } from "@/files/content/skills";
import { WORKSPACE_STARTER_AUTOMATION_CONTENT } from "@/files/content/starter-automations";
import { createUploadFileSystem } from "@/files/contributors/upload";
import { FileSystemError } from "@/files/fs-errors";
import type { IFileSystem } from "@/files/interface";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createUploadCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/upload-files";

const uploadProviderSchema = z.enum(["database", "r2", "r2-binding"]);

export const uploadConfigureInputSchema = z
  .object({
    provider: uploadProviderSchema.optional(),
    defaultProvider: uploadProviderSchema.optional(),
  })
  .passthrough();

const capability = { id: "upload", label: "Upload", kind: "connection" } as const;
const getUploadDo = (env: CloudflareEnv, orgId: string) =>
  env.UPLOAD.get(env.UPLOAD.idFromName(orgId));

type UploadAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
  providers?: Record<string, { configured?: boolean }>;
};

const isUploadConfigured = (response: UploadAdminConfigResponse) =>
  response.configured === true ||
  Object.values(response.providers ?? {}).some((provider) => provider.configured === true);

const toUploadStatus = (response: UploadAdminConfigResponse): ConnectionStatus => {
  if (!isUploadConfigured(response)) {
    return {
      ...capability,
      configured: false,
      missing: ["provider"],
    };
  }

  return {
    ...capability,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

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

const copyWorkspaceStarterFiles = async ({ env, orgId }: { env: CloudflareEnv; orgId: string }) => {
  const uploadDo = getUploadDo(env, orgId);
  const fs = createUploadFileSystem(
    {
      orgId,
      uploadConfig: await uploadDo.getAdminConfig(),
      uploadRuntime: {
        baseUrl: "https://files.internal",
        fetch: uploadDo.fetch.bind(uploadDo),
      },
    },
    { mountPoint: "/workspace", provider: "database" },
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

  for (const [relativePath, content] of Object.entries(starterContent)) {
    const path = `/workspace/${relativePath.replace(/^\/+/, "")}`;
    if (await fileExists(fs, path)) {
      continue;
    }

    await fs.writeFile(path, content);
  }
};

export const uploadCapability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: [],
  get files() {
    return createUploadCapabilityFiles();
  },
  connection: {
    configurable: true,
    configureInputSchema: uploadConfigureInputSchema,
    configureFields: [
      { name: "provider", description: "Provider to configure: database, r2-binding, or r2." },
      { name: "defaultProvider", description: "Default provider to use after configuration." },
      { name: "r2", secret: true, description: "R2 provider credentials/configuration payload." },
      { name: "r2Binding", description: "R2 binding provider configuration payload." },
    ],
    getStatus: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, origin, payload }) => {
      const status = toUploadStatus(
        await getUploadDo(env, orgId).setAdminConfig(
          uploadConfigureInputSchema.parse(payload),
          orgId,
          origin,
        ),
      );

      if (status.configured) {
        await copyWorkspaceStarterFiles({ env, orgId });
      }

      return status;
    },
  },
  hooks: [
    {
      id: "upload",
      label: "Upload",
      getRepository: ({ env, orgId }) => getUploadDo(env, orgId).getDurableHookRepository(),
    },
  ],
};
