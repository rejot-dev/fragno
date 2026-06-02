import { InMemoryFs, type FileSystem } from "@cloudflare/shell";

import type { IFileSystem } from "@/files/interface";

export class BackofficeStateFileSystem implements FileSystem {
  readonly #fs: IFileSystem;

  constructor(fs: IFileSystem) {
    this.#fs = fs;
  }

  async readFile(path: string): Promise<string> {
    return this.#withEnoent(path, "readFile", () => this.#fs.readFile(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.#withEnoent(path, "readFileBytes", () => this.#fs.readFileBuffer(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#withEnoent(path, "writeFile", () => this.#fs.writeFile(path, content));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.#withEnoent(path, "writeFileBytes", () => this.#fs.writeFile(path, content));
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.#withEnoent(path, "appendFile", () => this.#fs.appendFile(path, content));
  }

  async exists(path: string): Promise<boolean> {
    return this.#fs.exists(path);
  }

  async stat(path: string): Promise<FileSystemStat> {
    const stat = await this.#withEnoent(path, "stat", () => this.#fs.stat(path));
    return {
      type: stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : "file",
      size: stat.size,
      mtime: stat.mtime,
      mode: stat.mode,
    };
  }

  async lstat(path: string): Promise<FileSystemStat> {
    const stat = await this.#withEnoent(path, "lstat", () => this.#fs.lstat(path));
    return {
      type: stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : "file",
      size: stat.size,
      mtime: stat.mtime,
      mode: stat.mode,
    };
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.#withEnoent(path, "mkdir", () => this.#fs.mkdir(path, options));
  }

  async readdir(path: string): Promise<string[]> {
    return this.#withEnoent(path, "readdir", () => this.#fs.readdir(path));
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    const entries = this.#fs.readdirWithFileTypes
      ? await this.#withEnoent(
          path,
          "readdirWithFileTypes",
          () => this.#fs.readdirWithFileTypes?.(path) ?? Promise.resolve([]),
        )
      : await this.#withEnoent(path, "readdirWithFileTypes", async () => {
          const names = await this.#fs.readdir(path);
          return Promise.all(
            names.map(async (name) => {
              const childPath = this.resolvePath(path, name);
              const stat = await this.#fs.lstat(childPath);
              return {
                name,
                isFile: stat.isFile,
                isDirectory: stat.isDirectory,
                isSymbolicLink: stat.isSymbolicLink,
              };
            }),
          );
        });

    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : "file",
    }));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.#withEnoent(path, "rm", () => this.#fs.rm(path, options));
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    await this.#withEnoent(src, "cp", () => this.#fs.cp(src, dest, options));
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.#withEnoent(src, "mv", () => this.#fs.mv(src, dest));
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.#withEnoent(linkPath, "symlink", () => this.#fs.symlink(target, linkPath));
  }

  async readlink(path: string): Promise<string> {
    return this.#withEnoent(path, "readlink", () => this.#fs.readlink(path));
  }

  async realpath(path: string): Promise<string> {
    return this.#withEnoent(path, "realpath", () => this.#fs.realpath(path));
  }

  resolvePath(base: string, path: string): string {
    return this.#fs.resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    const globFs = new InMemoryFs();

    for (const path of this.#fs.getAllPaths()) {
      if (path === "/") {
        continue;
      }

      const stat = await this.#withEnoent(path, "glob", () => this.#fs.lstat(path));
      if (stat.isDirectory) {
        await globFs.mkdir(path, { recursive: true });
        continue;
      }

      if (stat.isFile) {
        await globFs.writeFile(path, "");
      }
    }

    return globFs.glob(pattern);
  }

  async #withEnoent<T>(path: string, operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isMissingPathError(error)) {
        throw createEnoentError(operation, path, error);
      }
      throw error;
    }
  }
}

type FileSystemStat = Awaited<ReturnType<FileSystem["stat"]>>;
type FileSystemDirent = Awaited<ReturnType<FileSystem["readdirWithFileTypes"]>>[number];

const isMissingPathError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /ENOENT|not found|not inside a mounted filesystem/i.test(error.message);
};

const createEnoentError = (operation: string, path: string, cause: unknown): Error => {
  const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
  return new Error(`ENOENT: no such file or directory, ${operation} '${path}'${causeMessage}`);
};
