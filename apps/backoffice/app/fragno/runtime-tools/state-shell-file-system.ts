import { Buffer } from "node:buffer";
import { posix } from "node:path";

import type { BufferEncoding, FileContent, FsStat, IFileSystem } from "just-bash";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

/** Adapts shared state storage to the shell without storing POSIX ownership or permissions. */
export function createStateShellFileSystem(state: BackofficeStateBackend): IFileSystem {
  async function stat(path: string): Promise<FsStat> {
    const entry = await state.stat(path);
    if (!entry) {
      throw shellFileSystemError("ENOENT", "stat", path);
    }
    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      // Shell stat formatting needs a mode; state scope rules, not these bits, authorize operations.
      mode: entry.type === "directory" ? 0o755 : 0o644,
      size: entry.size,
      mtime: entry.mtime,
    };
  }

  async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (!options?.recursive) {
      return state.mkdir(path);
    }
    if (await fs.exists(path)) {
      if (!(await stat(path)).isDirectory) {
        throw shellFileSystemError("ENOTDIR", "mkdir", path);
      }
      return;
    }
    await mkdir(posix.dirname(path), options);
    await state.mkdir(path);
  }

  async function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const absolutePath = posix.resolve("/", path);
    // Mount roots must be rejected before recursive traversal can delete their contents.
    if (options?.recursive && posix.dirname(absolutePath) !== "/" && (await fs.exists(path))) {
      if ((await stat(path)).isDirectory) {
        for (const name of await state.readdir(path)) {
          await rm(posix.join(path, name), options);
        }
      }
    }
    await state.rm(path, options);
  }

  async function cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    if (!(await stat(src)).isDirectory) {
      await state.writeFileBytes(dest, await state.readFileBytes(src));
      return;
    }
    if (!options?.recursive) {
      throw shellFileSystemError("EISDIR", "cp", src);
    }
    if (
      posix.resolve(dest).startsWith(`${posix.resolve(src)}/`) ||
      posix.resolve(src) === posix.resolve(dest)
    ) {
      throw shellFileSystemError("EINVAL", "cp", dest);
    }
    await mkdir(dest, { recursive: true });
    for (const name of await state.readdir(src)) {
      await cp(posix.join(src, name), posix.join(dest, name), options);
    }
  }

  const fs: IFileSystem = {
    async readFile(path, options) {
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding
        ? Buffer.from(await state.readFileBytes(path)).toString(encoding)
        : state.readFile(path);
    },
    readFileBuffer: (path) => state.readFileBytes(path),
    async writeFile(path, content, options) {
      await state.writeFileBytes(path, shellContentBytes(content, options));
    },
    async appendFile(path, content, options) {
      await state.appendFile(path, shellContentBytes(content, options));
    },
    async exists(path) {
      try {
        return await state.exists(path);
      } catch (error) {
        if ((error as { code: string }).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    stat,
    lstat: stat,
    mkdir,
    readdir: (path) => state.readdir(path),
    async readdirWithFileTypes(path) {
      return (await state.readdirWithFileTypes(path)).map((entry) => ({
        name: entry.name,
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
      }));
    },
    rm,
    cp,
    mv: (src, dest) => state.mv(src, dest),
    resolvePath: (base, path) => state.resolvePath(base, path),
    // just-bash discovers remote paths through readdir; synchronous enumeration cannot query Upload.
    getAllPaths: () => [],
    async chmod(path) {
      throw shellFileSystemError("ENOTSUP", "chmod", path);
    },
    async utimes(path) {
      // touch calls utimes after creating a file; timestamps remain owned by shared state storage.
      await stat(path);
    },
    async link(_target, path) {
      throw shellFileSystemError("ENOTSUP", "link", path);
    },
    async symlink(target, path) {
      state.symlink(target, path);
    },
    async readlink(path) {
      return state.readlink(path);
    },
    realpath: (path) => state.realpath(path),
  };
  return fs;
}

function shellContentBytes(
  content: FileContent,
  options: { encoding?: BufferEncoding } | BufferEncoding | undefined,
): Uint8Array {
  return typeof content === "string"
    ? Buffer.from(content, typeof options === "string" ? options : (options?.encoding ?? "utf8"))
    : content;
}

function shellFileSystemError(code: string, operation: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${operation} '${path}'`), { code });
}
