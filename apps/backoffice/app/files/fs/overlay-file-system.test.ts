import { describe, expect, test } from "vitest";

import type { FsStat } from "../interface";
import { normalizeMountedFileSystem } from "../mounted-file-system";
import { createOverlayMountedFileSystem } from "./overlay-file-system";

const DIRECTORY_STAT: FsStat = {
  isFile: false,
  isDirectory: true,
  isSymbolicLink: false,
  mode: 0o755,
  size: 0,
  mtime: new Date(0),
};

const createFileStat = (size: number): FsStat => ({
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  mode: 0o644,
  size,
  mtime: new Date(0),
});

describe("createOverlayMountedFileSystem", () => {
  test("forwards chmod to the write layer", async () => {
    const mountPoint = "/workspace";
    const chmodCalls: Array<{ path: string; mode: number }> = [];

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: true },
    );

    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/automations/scripts/say-hi.sh";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/automations/scripts/say-hi.sh") {
            return createFileStat(7);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["automations"];
          }
          if (path === "/workspace/automations") {
            return ["scripts"];
          }
          if (path === "/workspace/automations/scripts") {
            return ["say-hi.sh"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/automations/scripts/say-hi.sh") {
            throw new Error("Path not found.");
          }

          return "echo hi";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/automations/scripts/say-hi.sh") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("echo hi");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod(path, mode) {
          chmodCalls.push({ path, mode });
        },
        getAllPaths() {
          return [mountPoint, "/workspace/automations/scripts/say-hi.sh"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await overlay.chmod("/workspace/automations/scripts/say-hi.sh", 0o755);

    expect(chmodCalls).toEqual([{ path: "/workspace/automations/scripts/say-hi.sh", mode: 0o755 }]);
  });

  test("forwards utimes to the write layer", async () => {
    const mountPoint = "/workspace";
    const utimesCalls: Array<{ path: string; atime: Date; mtime: Date }> = [];

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: true },
    );

    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/automations/scripts/say-hi.sh";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/automations/scripts/say-hi.sh") {
            return createFileStat(7);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["automations"];
          }
          if (path === "/workspace/automations") {
            return ["scripts"];
          }
          if (path === "/workspace/automations/scripts") {
            return ["say-hi.sh"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/automations/scripts/say-hi.sh") {
            throw new Error("Path not found.");
          }

          return "echo hi";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/automations/scripts/say-hi.sh") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("echo hi");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes(path, atime, mtime) {
          utimesCalls.push({ path, atime, mtime });
        },
        getAllPaths() {
          return [mountPoint, "/workspace/automations/scripts/say-hi.sh"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    const atime = new Date("2024-01-01T00:00:00.000Z");
    const mtime = new Date("2024-01-02T00:00:00.000Z");
    await overlay.utimes("/workspace/automations/scripts/say-hi.sh", atime, mtime);

    expect(utimesCalls).toEqual([
      { path: "/workspace/automations/scripts/say-hi.sh", atime, mtime },
    ]);
  });

  test("falls back to the read layer without an exists preflight for file reads", async () => {
    const mountPoint = "/workspace";
    let writeExistsCalls = 0;

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/input/notes.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input/notes.md") {
            return createFileStat(12);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["input"];
          }
          if (path === "/workspace/input") {
            return ["notes.md"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/input/notes.md") {
            throw new Error("Path not found.");
          }

          return "starter note";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/input/notes.md") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("starter note");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/input", "/workspace/input/notes.md"];
        },
      },
      { readOnly: true },
    );

    const writeLayer = normalizeMountedFileSystem(
      {
        async exists() {
          writeExistsCalls += 1;
          return false;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("File not found.");
        },
        async readFileBuffer() {
          throw new Error("File not found.");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await expect(overlay.readFile("/workspace/input/notes.md")).resolves.toBe("starter note");
    await expect(overlay.readFileBuffer("/workspace/input/notes.md")).resolves.toEqual(
      new TextEncoder().encode("starter note"),
    );
    expect(writeExistsCalls).toBe(0);
  });

  test("does not fall back to read-layer buffer or stream reads when the write layer shadows a path with a directory", async () => {
    const mountPoint = "/workspace";
    let readLayerBufferCalls = 0;
    let readLayerStreamCalls = 0;

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/input/notes.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input/notes.md") {
            return createFileStat(12);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["input"];
          }
          if (path === "/workspace/input") {
            return ["notes.md"];
          }

          return [];
        },
        async readFile() {
          return "starter note";
        },
        async readFileBuffer() {
          readLayerBufferCalls += 1;
          return new TextEncoder().encode("starter note");
        },
        async readFileStream() {
          readLayerStreamCalls += 1;
          return createTextStream("starter note");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/input", "/workspace/input/notes.md"];
        },
      },
      { readOnly: true },
    );

    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return (
            path === mountPoint ||
            path === "/workspace/input" ||
            path === "/workspace/input/notes.md"
          );
        },
        async stat(path) {
          if (path === mountPoint || path === "/workspace/input") {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input/notes.md") {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["input"];
          }
          if (path === "/workspace/input") {
            return ["notes.md"];
          }
          if (path === "/workspace/input/notes.md") {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        async readFileStream() {
          throw new Error("Path not found.");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint, "/workspace/input", "/workspace/input/notes.md"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await expect(overlay.readFileBuffer("/workspace/input/notes.md")).rejects.toThrow(
      "This mounted filesystem does not support reading files.",
    );

    if (!overlay.readFileStream) {
      throw new Error("Expected overlay filesystem to support read streams.");
    }

    await expect(overlay.readFileStream("/workspace/input/notes.md")).rejects.toThrow(
      "ENOTSUP: operation not supported, read stream '/workspace/input/notes.md'",
    );
    expect(readLayerBufferCalls).toBe(0);
    expect(readLayerStreamCalls).toBe(0);
  });

  test("passes read streams through from both the write and read layers", async () => {
    const mountPoint = "/workspace";
    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/input/notes.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input/notes.md") {
            return createFileStat(12);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["input"];
          }
          if (path === "/workspace/input") {
            return ["notes.md"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/input/notes.md") {
            throw new Error("Path not found.");
          }

          return "starter note";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/input/notes.md") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("starter note");
        },
        async readFileStream(path) {
          if (path !== "/workspace/input/notes.md") {
            throw new Error("Path not found.");
          }

          return createTextStream("starter note");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/input", "/workspace/input/notes.md"];
        },
      },
      { readOnly: true },
    );
    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/README.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/README.md") {
            return createFileStat(16);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["README.md"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return "persistent readme";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("persistent readme");
        },
        async readFileStream(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return createTextStream("persistent readme");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/README.md"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    if (!overlay.readFileStream) {
      throw new Error("Expected overlay filesystem to support read streams.");
    }

    await expect(readStream(await overlay.readFileStream("/workspace/README.md"))).resolves.toBe(
      "persistent readme",
    );
    await expect(
      readStream(await overlay.readFileStream("/workspace/input/notes.md")),
    ).resolves.toBe("starter note");
  });

  test("hides read-layer descendants when a write-layer file shadows a directory", async () => {
    const mountPoint = "/workspace";
    const normalize = (path: string) => path.replace(/\/+$/, "") || "/";

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          const normalizedPath = normalize(path);
          return (
            normalizedPath === mountPoint ||
            normalizedPath === "/workspace/docs" ||
            normalizedPath === "/workspace/docs/readme.md" ||
            normalizedPath === "/workspace/notes.md"
          );
        },
        async stat(path) {
          const normalizedPath = normalize(path);
          if (normalizedPath === mountPoint || normalizedPath === "/workspace/docs") {
            return DIRECTORY_STAT;
          }
          if (normalizedPath === "/workspace/docs/readme.md") {
            return createFileStat(12);
          }
          if (normalizedPath === "/workspace/notes.md") {
            return createFileStat(5);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          const normalizedPath = normalize(path);
          if (normalizedPath === mountPoint) {
            return ["docs", "docs/readme.md", "notes.md"];
          }
          if (normalizedPath === "/workspace/docs") {
            return ["readme.md"];
          }

          return [];
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        getAllPaths() {
          return [
            mountPoint,
            "/workspace/docs",
            "/workspace/docs/readme.md",
            "/workspace/notes.md",
          ];
        },
      },
      { readOnly: true },
    );

    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          const normalizedPath = normalize(path);
          return normalizedPath === mountPoint || normalizedPath === "/workspace/docs";
        },
        async stat(path) {
          const normalizedPath = normalize(path);
          if (normalizedPath === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (normalizedPath === "/workspace/docs") {
            return createFileStat(7);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (normalize(path) === mountPoint) {
            return ["docs"];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint, "/workspace/docs"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await expect(overlay.readdir("/workspace")).resolves.toEqual(["docs", "notes.md"]);
    await expect(overlay.readdirWithFileTypes("/workspace")).resolves.toEqual([
      {
        name: "docs",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
      {
        name: "notes.md",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
    ]);
    await expect(overlay.readdir("/workspace/docs")).rejects.toThrow("Path not found.");
  });

  test("reads write-layer streams without an exists preflight", async () => {
    const mountPoint = "/workspace";
    let writeExistsCalls = 0;

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/README.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/README.md") {
            return createFileStat(14);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["README.md"];
          }

          return [];
        },
        async readFile() {
          return "starter readme";
        },
        async readFileBuffer() {
          return new TextEncoder().encode("starter readme");
        },
        async readFileStream() {
          return createTextStream("starter readme");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/README.md"];
        },
      },
      { readOnly: true },
    );
    const writeLayer = normalizeMountedFileSystem(
      {
        async exists() {
          writeExistsCalls += 1;
          throw new Error("upload unavailable");
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/README.md") {
            return createFileStat(17);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["README.md"];
          }

          return [];
        },
        async readFile(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return "persistent readme";
        },
        async readFileBuffer(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return new TextEncoder().encode("persistent readme");
        },
        async readFileStream(path) {
          if (path !== "/workspace/README.md") {
            throw new Error("Path not found.");
          }

          return createTextStream("persistent readme");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint, "/workspace/README.md"];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    if (!overlay.readFileStream) {
      throw new Error("Expected overlay filesystem to support read streams.");
    }

    await expect(readStream(await overlay.readFileStream("/workspace/README.md"))).resolves.toBe(
      "persistent readme",
    );
    expect(writeExistsCalls).toBe(0);
  });

  test("propagates directory listing errors from the write layer", async () => {
    const mountPoint = "/workspace";

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint || path === "/workspace/input/notes.md";
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input") {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/input/notes.md") {
            return createFileStat(12);
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return ["input"];
          }
          if (path === "/workspace/input") {
            return ["notes.md"];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        getAllPaths() {
          return [mountPoint, "/workspace/input", "/workspace/input/notes.md"];
        },
      },
      { readOnly: true },
    );
    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir() {
          throw new Error("upload unavailable");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await expect(overlay.readdir("/workspace")).rejects.toThrow("upload unavailable");
  });

  test("propagates write-layer lookup failures during forced deletes", async () => {
    const mountPoint = "/workspace";

    const readLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: true },
    );
    const writeLayer = normalizeMountedFileSystem(
      {
        async exists(path) {
          return path === mountPoint;
        },
        async stat(path) {
          if (path === mountPoint) {
            return DIRECTORY_STAT;
          }
          if (path === "/workspace/output/generated.txt") {
            throw new Error("upload unavailable");
          }

          throw new Error("Path not found.");
        },
        async readdir(path) {
          if (path === mountPoint) {
            return [];
          }

          throw new Error("Path not found.");
        },
        async readFile() {
          throw new Error("Path not found.");
        },
        async readFileBuffer() {
          throw new Error("Path not found.");
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {
          throw new Error("rm should not be called");
        },
        async chmod() {},
        async utimes() {},
        getAllPaths() {
          return [mountPoint];
        },
      },
      { readOnly: false },
    ) as Parameters<typeof createOverlayMountedFileSystem>[0]["writeLayer"];

    const overlay = createOverlayMountedFileSystem({
      mountPoint,
      readLayer,
      writeLayer,
    });

    await expect(overlay.rm("/workspace/output/generated.txt", { force: true })).rejects.toThrow(
      "upload unavailable",
    );
  });
});

const createTextStream = (value: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
};
