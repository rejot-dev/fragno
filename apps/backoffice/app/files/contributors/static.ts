import { SYSTEM_FILE_CONTENT } from "../content/system";
import type { FileContributor, FileMountMetadata } from "../types";
import { createReadOnlyContentFileSystem } from "./content";

const STATIC_FILE_MOUNT_ID = "system";
export const STATIC_FILE_MOUNT_POINT = "/system";

export const staticFileMount: FileMountMetadata = {
  id: STATIC_FILE_MOUNT_ID,
  kind: "static",
  mountPoint: STATIC_FILE_MOUNT_POINT,
  title: "System",
  readOnly: true,
  persistence: "persistent",
  description:
    "Immutable TS-owned guidance, skills, and system automations for the built-in /system filesystem.",
};

export const staticFileContributor: FileContributor = {
  ...staticFileMount,
  ...createReadOnlyContentFileSystem(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT),
};
