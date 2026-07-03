import { STATIC_FILE_CONTENT } from "../content/static";
import { SYSTEM_FILE_CONTENT } from "../content/system";
import type { FileContributor, FileMountMetadata, FilesContext } from "../types";
import { createReadOnlyContentFileSystem } from "./content";

const STATIC_FILE_MOUNT_ID = "static";
export const STATIC_FILE_MOUNT_POINT = "/static";

export const staticFileMount: FileMountMetadata = {
  id: STATIC_FILE_MOUNT_ID,
  kind: "static",
  mountPoint: STATIC_FILE_MOUNT_POINT,
  title: "Static",
  readOnly: true,
  persistence: "persistent",
  description:
    "Immutable product-owned guidance, skills, codemode declarations, and static automations.",
};

const createStaticFileSystem = (ctx: FilesContext) =>
  createReadOnlyContentFileSystem(STATIC_FILE_MOUNT_POINT, STATIC_FILE_CONTENT, {
    lazyArtifacts: [{ pathPrefix: "codemode", load: ctx.staticFileArtifacts }],
  });

export const staticFileContributor: FileContributor = {
  ...staticFileMount,
  ...createReadOnlyContentFileSystem(STATIC_FILE_MOUNT_POINT, STATIC_FILE_CONTENT),
  createFileSystem: (ctx) => createStaticFileSystem(ctx),
};

const SYSTEM_FILE_MOUNT_ID = "system";
export const SYSTEM_FILE_MOUNT_POINT = "/system";

export const systemFileMount: FileMountMetadata = {
  id: SYSTEM_FILE_MOUNT_ID,
  kind: "static",
  mountPoint: SYSTEM_FILE_MOUNT_POINT,
  title: "System",
  readOnly: true,
  persistence: "persistent",
  description: "Admin-only system-scope filesystem for system automations and metadata.",
};

const canSeeSystemFileMount = ({ execution }: FilesContext): boolean =>
  execution.scope.kind === "system" ||
  execution.actor.type === "system" ||
  (execution.actor.type === "user" && execution.actor.role === "admin");

export const systemFileContributor: FileContributor = {
  ...systemFileMount,
  ...createReadOnlyContentFileSystem(SYSTEM_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT),
  createFileSystem: (ctx) =>
    canSeeSystemFileMount(ctx)
      ? createReadOnlyContentFileSystem(SYSTEM_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT)
      : null,
};
