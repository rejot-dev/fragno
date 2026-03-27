import { STARTER_WORKSPACE_CONTENT, STARTER_WORKSPACE_ROOT_DESCRIPTION } from "../content/starter";
import { createOverlayMountedFileSystem } from "../fs/overlay-file-system";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import type {
  FileContributor,
  FileMountMetadata,
  FilesContext,
  MountedFileSystem,
  MountedFileSystemResolution,
} from "../types";
import {
  findContentEntry,
  listContentChildNames,
  listContentDirents,
  readContentBuffer,
  readContentText,
  statContentEntry,
} from "./content";
import {
  createUploadMountedFileSystem,
  isUploadConfigured,
  resolveBoundUploadProvider,
} from "./upload";

export const STARTER_FILE_CONTRIBUTOR_ID = "workspace";
export const STARTER_FILE_MOUNT_ID = "workspace";
export const STARTER_FILE_MOUNT_POINT = "/workspace";

export const starterFileMount: FileMountMetadata = {
  id: STARTER_FILE_MOUNT_ID,
  kind: "starter",
  mountPoint: STARTER_FILE_MOUNT_POINT,
  title: "Workspace",
  readOnly: true,
  persistence: "session",
  description: STARTER_WORKSPACE_ROOT_DESCRIPTION,
};

export const createStarterMountedFileSystem = (): MountedFileSystem =>
  normalizeMountedFileSystem(
    {
      async describeEntry(path) {
        return findContentEntry(STARTER_FILE_MOUNT_POINT, STARTER_WORKSPACE_CONTENT, path);
      },
      async exists(path) {
        return (
          statContentEntry(STARTER_FILE_MOUNT_POINT, STARTER_WORKSPACE_CONTENT, path, false) !==
          null
        );
      },
      async stat(path) {
        const entry = statContentEntry(
          STARTER_FILE_MOUNT_POINT,
          STARTER_WORKSPACE_CONTENT,
          path,
          false,
        );
        if (!entry) {
          throw new Error("Path not found.");
        }

        return entry;
      },
      async readdir(path) {
        return listContentChildNames(STARTER_FILE_MOUNT_POINT, STARTER_WORKSPACE_CONTENT, path);
      },
      async readdirWithFileTypes(path) {
        return listContentDirents(STARTER_FILE_MOUNT_POINT, STARTER_WORKSPACE_CONTENT, path);
      },
      async readFile(path) {
        const artifact = readContentText(STARTER_FILE_MOUNT_POINT, STARTER_WORKSPACE_CONTENT, path);
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      async readFileBuffer(path) {
        const artifact = readContentBuffer(
          STARTER_FILE_MOUNT_POINT,
          STARTER_WORKSPACE_CONTENT,
          path,
        );
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      getAllPaths() {
        return [
          STARTER_FILE_MOUNT_POINT,
          ...Object.keys(STARTER_WORKSPACE_CONTENT).map(
            (path) => `${STARTER_FILE_MOUNT_POINT}/${path}`,
          ),
        ];
      },
    },
    { readOnly: true },
  );

const canUsePersistentWorkspaceLayer = (ctx: FilesContext): boolean => {
  if (!isUploadConfigured(ctx.uploadConfig)) {
    return false;
  }

  return Boolean(ctx.uploadRuntime);
};

const describeWorkspaceRoot = (ctx: FilesContext, writable: boolean): string => {
  if (writable) {
    return [
      "Starter workspace files layered under persistent organisation files routed through the Upload fragment.",
      "Persistent files override starter files at the same /workspace path, and deleting a persistent override reveals the starter file again.",
    ].join(" ");
  }

  if (isUploadConfigured(ctx.uploadConfig)) {
    return [
      "Starter workspace files layered under an optional persistent Upload-backed overlay.",
      "This runtime only has the starter layer mounted here, so /workspace is currently read-only.",
    ].join(" ");
  }

  return [
    "Starter workspace files layered under an optional persistent Upload-backed overlay.",
    "Upload is not configured for this org, so /workspace is currently read-only.",
  ].join(" ");
};

const resolveStarterMountedFileSystem = (ctx: FilesContext): MountedFileSystemResolution => {
  const readLayer = createStarterMountedFileSystem();

  if (!canUsePersistentWorkspaceLayer(ctx)) {
    return {
      fs: readLayer,
      mount: {
        readOnly: true,
        persistence: "session",
        description: describeWorkspaceRoot(ctx, false),
      },
    };
  }

  const uploadProvider = resolveBoundUploadProvider(ctx.uploadConfig);
  const uploadLayer = createUploadMountedFileSystem(ctx, {
    mountPoint: STARTER_FILE_MOUNT_POINT,
    provider: uploadProvider,
  });

  return {
    fs: createOverlayMountedFileSystem({
      mountPoint: STARTER_FILE_MOUNT_POINT,
      readLayer,
      writeLayer: uploadLayer as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"],
    }),
    mount: {
      readOnly: false,
      persistence: "persistent",
      description: describeWorkspaceRoot(ctx, true),
      uploadProvider,
    },
  };
};

export const starterFileContributor: FileContributor = {
  ...starterFileMount,
  ...createStarterMountedFileSystem(),
  createFileSystem(ctx) {
    return resolveStarterMountedFileSystem(ctx);
  },
};
