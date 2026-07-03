import { InMemoryFs } from "just-bash";

import { createPathNotFoundFileSystemError } from "@/files/fs-errors";
import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";

export const createTestMasterFileSystem = (
  files: Record<string, string | Uint8Array>,
): MasterFileSystem =>
  new MasterFileSystem({
    mounts: [
      ...(hasMountedFiles(files, "/static") ? [createTestMount("static", "/static", files)] : []),
      ...(hasMountedFiles(files, "/system") ? [createTestMount("system", "/system", files)] : []),
      createTestMount("workspace", "/workspace", files),
    ],
  });

const createTestMount = (
  id: string,
  mountPoint: string,
  files: Record<string, string | Uint8Array>,
): ResolvedFileMount => ({
  id,
  kind: "custom",
  mountPoint,
  title: id,
  readOnly: false,
  persistence: "session",
  fs: createMountedInMemoryFs(files),
});

const createMountedInMemoryFs = (files: Record<string, string | Uint8Array>) => {
  const fs = new InMemoryFs(files);

  return {
    readFile: (path: string) => fs.readFile(path),
    readFileBuffer: (path: string) => fs.readFileBuffer(path),
    writeFile: async (path: string, content: string | Uint8Array) => {
      await fs.mkdir(parentPath(path), { recursive: true });
      await fs.writeFile(path, content);
    },
    appendFile: (path: string, content: string | Uint8Array) => fs.appendFile(path, content),
    exists: (path: string) => fs.exists(path),
    stat: async (path: string) => {
      if (!(await fs.exists(path))) {
        throw createPathNotFoundFileSystemError("stat", path);
      }
      return fs.stat(path);
    },
    mkdir: (path: string, options?: { recursive?: boolean }) => fs.mkdir(path, options),
    readdir: (path: string) => fs.readdir(path),
    readdirWithFileTypes: (path: string) => fs.readdirWithFileTypes(path),
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => fs.rm(path, options),
    cp: (src: string, dest: string, options?: { recursive?: boolean }) => fs.cp(src, dest, options),
    mv: (src: string, dest: string) => fs.mv(src, dest),
    resolvePath: (base: string, path: string) => fs.resolvePath(base, path),
    getAllPaths: () => fs.getAllPaths(),
    chmod: (path: string, mode: number) => fs.chmod(path, mode),
    symlink: (target: string, linkPath: string) => fs.symlink(target, linkPath),
    link: (existingPath: string, newPath: string) => fs.link(existingPath, newPath),
    readlink: (path: string) => fs.readlink(path),
    lstat: (path: string) => fs.lstat(path),
    realpath: (path: string) => fs.realpath(path),
    utimes: (path: string, atime: Date, mtime: Date) => fs.utimes(path, atime, mtime),
  };
};

const parentPath = (path: string): string => {
  const segments = path.split("/").filter(Boolean);
  return segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
};

const hasMountedFiles = (files: Record<string, string | Uint8Array>, mountPoint: string): boolean =>
  Object.keys(files).some((path) => path === mountPoint || path.startsWith(`${mountPoint}/`));
