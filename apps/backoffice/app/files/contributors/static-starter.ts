import { STATIC_STARTER_CONTENT, STATIC_STARTER_ROOT_DESCRIPTION } from "../content/starter";
import type { IFileSystem } from "../interface";
import type { FileContributor, FileMountMetadata } from "../types";
import { createReadOnlyContentFileSystem } from "./content";
export const STATIC_STARTER_FILE_CONTRIBUTOR_ID = "static-starter";
export const STATIC_STARTER_FILE_MOUNT_ID = "static-starter";
export const STATIC_STARTER_FILE_MOUNT_POINT = "/starter";

export const staticStarterFileMount: FileMountMetadata = {
  id: STATIC_STARTER_FILE_MOUNT_ID,
  kind: "static",
  mountPoint: STATIC_STARTER_FILE_MOUNT_POINT,
  title: "Static Starter",
  readOnly: true,
  persistence: "persistent",
  description: STATIC_STARTER_ROOT_DESCRIPTION,
};

export const createStaticStarterFileSystem = (): IFileSystem =>
  createReadOnlyContentFileSystem(STATIC_STARTER_FILE_MOUNT_POINT, STATIC_STARTER_CONTENT);

export const staticStarterFileContributor: FileContributor = {
  ...staticStarterFileMount,
  ...createStaticStarterFileSystem(),
};
