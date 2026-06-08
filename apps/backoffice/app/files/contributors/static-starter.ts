import { STATIC_STARTER_CONTENT, STATIC_STARTER_ROOT_DESCRIPTION } from "../content/starter";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import type { FileContributor, FileMountMetadata, MountedFileSystem } from "../types";
import {
  findContentEntry,
  listContentChildNames,
  listContentDirents,
  readContentBuffer,
  readContentText,
  statContentEntry,
} from "./content";
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

export const createStaticStarterMountedFileSystem = (): MountedFileSystem =>
  normalizeMountedFileSystem(
    {
      async describeEntry(path) {
        return findContentEntry(STATIC_STARTER_FILE_MOUNT_POINT, STATIC_STARTER_CONTENT, path);
      },
      async exists(path) {
        return (
          statContentEntry(STATIC_STARTER_FILE_MOUNT_POINT, STATIC_STARTER_CONTENT, path, false) !==
          null
        );
      },
      async stat(path) {
        const entry = statContentEntry(
          STATIC_STARTER_FILE_MOUNT_POINT,
          STATIC_STARTER_CONTENT,
          path,
          false,
        );
        if (!entry) {
          throw new Error("Path not found.");
        }

        return entry;
      },
      async readdir(path) {
        return listContentChildNames(STATIC_STARTER_FILE_MOUNT_POINT, STATIC_STARTER_CONTENT, path);
      },
      async readdirWithFileTypes(path) {
        return listContentDirents(STATIC_STARTER_FILE_MOUNT_POINT, STATIC_STARTER_CONTENT, path);
      },
      async readFile(path) {
        const artifact = readContentText(
          STATIC_STARTER_FILE_MOUNT_POINT,
          STATIC_STARTER_CONTENT,
          path,
        );
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      async readFileBuffer(path) {
        const artifact = readContentBuffer(
          STATIC_STARTER_FILE_MOUNT_POINT,
          STATIC_STARTER_CONTENT,
          path,
        );
        if (artifact === null) {
          throw new Error("File not found.");
        }

        return artifact;
      },
      getAllPaths() {
        return [
          STATIC_STARTER_FILE_MOUNT_POINT,
          ...Object.keys(STATIC_STARTER_CONTENT).map(
            (path) => `${STATIC_STARTER_FILE_MOUNT_POINT}/${path}`,
          ),
        ];
      },
    },
    { readOnly: true },
  );

export const staticStarterFileContributor: FileContributor = {
  ...staticStarterFileMount,
  ...createStaticStarterMountedFileSystem(),
};
