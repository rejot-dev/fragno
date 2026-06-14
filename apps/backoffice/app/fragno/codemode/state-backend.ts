import type { FileSystem, FsStat } from "@cloudflare/shell";

import type { ToolProvider } from "./runtime-api";

export class BackofficeFileSystemStateBackend {
  readonly fs: FileSystem;

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  readFile(path: string): Promise<string> {
    return this.fs.readFile(path);
  }

  readFileBytes(path: string): Promise<Uint8Array> {
    return this.fs.readFileBytes(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.fs.writeFile(path, content);
  }

  writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    return this.fs.writeFileBytes(path, content);
  }

  appendFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.fs.appendFile(path, content);
  }

  exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    return this.fs.stat(path);
  }

  lstat(path: string): Promise<FsStat> {
    return this.fs.lstat(path);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.mkdir(path, options);
  }

  readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  readdirWithFileTypes(path: string): ReturnType<FileSystem["readdirWithFileTypes"]> {
    return this.fs.readdirWithFileTypes(path);
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return this.fs.rm(path, options);
  }

  cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.cp(src, dest, options);
  }

  mv(src: string, dest: string): Promise<void> {
    return this.fs.mv(src, dest);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.fs.symlink(target, linkPath);
  }

  readlink(path: string): Promise<string> {
    return this.fs.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.fs.realpath(path);
  }

  resolvePath(base: string, path: string): string {
    return this.fs.resolvePath(base, path);
  }

  glob(pattern: string): Promise<string[]> {
    return this.fs.glob(pattern);
  }

  async readJson(path: string): Promise<unknown> {
    return JSON.parse(await this.readFile(path));
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, JSON.stringify(value, null, 2));
  }
}

const unsupportedStateTool = (name: string) => ({
  execute: () => {
    throw new Error(`state.${name} is not implemented for test codemode.`);
  },
});

export const stateToolsFromBackend = (backend: BackofficeFileSystemStateBackend): ToolProvider => ({
  name: "state",
  tools: {
    readFile: { execute: (path) => backend.readFile(String(path)) },
    readFileBytes: { execute: (path) => backend.readFileBytes(String(path)) },
    writeFile: {
      execute: async (path, content) => {
        await backend.writeFile(String(path), String(content ?? ""));
      },
    },
    writeFileBytes: {
      execute: async (path, content) => {
        await backend.writeFileBytes(String(path), toBytes(content));
      },
    },
    appendFile: {
      execute: async (path, content) => {
        await backend.appendFile(
          String(path),
          typeof content === "string" ? content : toBytes(content),
        );
      },
    },
    exists: { execute: (path) => backend.exists(String(path)) },
    stat: { execute: (path) => backend.stat(String(path)) },
    lstat: { execute: (path) => backend.lstat(String(path)) },
    mkdir: {
      execute: async (path, options) => {
        await backend.mkdir(String(path), parseOptions(options));
      },
    },
    readdir: { execute: (path) => backend.readdir(String(path)) },
    readdirWithFileTypes: { execute: (path) => backend.readdirWithFileTypes(String(path)) },
    rm: {
      execute: async (path, options) => {
        await backend.rm(String(path), parseOptions(options));
      },
    },
    cp: {
      execute: async (src, dest, options) => {
        await backend.cp(String(src), String(dest), parseOptions(options));
      },
    },
    mv: {
      execute: async (src, dest) => {
        await backend.mv(String(src), String(dest));
      },
    },
    symlink: {
      execute: async (target, linkPath) => {
        await backend.symlink(String(target), String(linkPath));
      },
    },
    readlink: { execute: (path) => backend.readlink(String(path)) },
    realpath: { execute: (path) => backend.realpath(String(path)) },
    resolvePath: { execute: (base, path) => backend.resolvePath(String(base), String(path)) },
    glob: { execute: (pattern) => backend.glob(String(pattern)) },
    readJson: { execute: (path) => backend.readJson(String(path)) },
    writeJson: {
      execute: async (path, value) => {
        await backend.writeJson(String(path), value);
      },
    },
    queryJson: unsupportedStateTool("queryJson"),
    updateJson: unsupportedStateTool("updateJson"),
    find: unsupportedStateTool("find"),
    walkTree: unsupportedStateTool("walkTree"),
    summarizeTree: unsupportedStateTool("summarizeTree"),
    searchText: unsupportedStateTool("searchText"),
    searchFiles: unsupportedStateTool("searchFiles"),
    replaceInFile: unsupportedStateTool("replaceInFile"),
    replaceInFiles: unsupportedStateTool("replaceInFiles"),
    diff: unsupportedStateTool("diff"),
    diffContent: unsupportedStateTool("diffContent"),
    removeTree: unsupportedStateTool("removeTree"),
    copyTree: unsupportedStateTool("copyTree"),
    moveTree: unsupportedStateTool("moveTree"),
    createArchive: unsupportedStateTool("createArchive"),
    listArchive: unsupportedStateTool("listArchive"),
    extractArchive: unsupportedStateTool("extractArchive"),
    compressFile: unsupportedStateTool("compressFile"),
    decompressFile: unsupportedStateTool("decompressFile"),
    hashFile: unsupportedStateTool("hashFile"),
    detectFile: unsupportedStateTool("detectFile"),
    planEdits: unsupportedStateTool("planEdits"),
    applyEditPlan: unsupportedStateTool("applyEditPlan"),
    applyEdits: unsupportedStateTool("applyEdits"),
  },
});

const parseOptions = (value: unknown): { recursive?: boolean; force?: boolean } | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const options = value as { recursive?: unknown; force?: unknown };
  return {
    ...(typeof options.recursive === "boolean" ? { recursive: options.recursive } : {}),
    ...(typeof options.force === "boolean" ? { force: options.force } : {}),
  };
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new TextEncoder().encode(String(value ?? ""));
};
