import { SYSTEM_FILE_CONTENT, SYSTEM_FILE_ROOT_DESCRIPTION } from "../content/system";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import type { FileContributor, FileMountMetadata } from "../types";
import {
  findContentEntry,
  listContentChildNames,
  listContentDirents,
  readContentBuffer,
  readContentText,
  statContentEntry,
} from "./content";

export const STATIC_FILE_CONTRIBUTOR_ID = "system";
export const STATIC_FILE_MOUNT_ID = "system";
export const STATIC_FILE_MOUNT_POINT = "/system";

export const staticFileMount: FileMountMetadata = {
  id: STATIC_FILE_MOUNT_ID,
  kind: "static",
  mountPoint: STATIC_FILE_MOUNT_POINT,
  title: "System",
  readOnly: true,
  persistence: "persistent",
  description: SYSTEM_FILE_ROOT_DESCRIPTION,
};

export const staticFileContributor: FileContributor = {
  ...staticFileMount,
  ...normalizeMountedFileSystem(
    {
      async describeEntry(path) {
        return findContentEntry(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path);
      },
      async exists(path) {
        return statContentEntry(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path, true) !== null;
      },
      async stat(path) {
        const entry = statContentEntry(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path, true);
        if (!entry) {
          throw new Error("Path not found.");
        }

        return entry;
      },
      async readdir(path) {
        return listContentChildNames(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path);
      },
      async readdirWithFileTypes(path) {
        return listContentDirents(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path);
      },
      async readFile(path) {
        const artifact = readContentText(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path);
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      async readFileBuffer(path) {
        const artifact = readContentBuffer(STATIC_FILE_MOUNT_POINT, SYSTEM_FILE_CONTENT, path);
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      getAllPaths() {
        return [
          STATIC_FILE_MOUNT_POINT,
          ...Object.keys(SYSTEM_FILE_CONTENT).map((path) => `${STATIC_FILE_MOUNT_POINT}/${path}`),
        ];
      },
    },
    { readOnly: true },
  ),
};
