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
