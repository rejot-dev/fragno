import {
  createPathNotFoundFileSystemError,
  createReadOnlyFileSystemError,
  createUnsupportedOperationFileSystemError,
} from "@/files/fs-errors";
import { createUnsupportedFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import type { ResolvedFileMount } from "@/files/types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Creates a read-only mount containing a single `/context/event.json` file.
 */
const createAutomationContextMount = ({
  contextFiles,
}: {
  contextFiles: Record<string, string>;
}): ResolvedFileMount => {
  const files = new Map<string, { content: string; bytes: Uint8Array }>();

  for (const [name, content] of Object.entries(contextFiles)) {
    const normalizedName = name.trim().replace(/^\/+/, "");
    if (!normalizedName || normalizedName.includes("/") || normalizedName === ".") {
      throw new Error(`Invalid automation context file name: ${name}`);
    }
    const path = `/context/${normalizedName}`;
    files.set(path, { content, bytes: TEXT_ENCODER.encode(content) });
  }

  const now = new Date();
  const MOUNT = "/context";
  const throwContextPathNotFound = (operation: string, path: string): never => {
    throw createPathNotFoundFileSystemError(operation, path);
  };

  return {
    id: "automation-context",
    kind: "custom",
    mountPoint: MOUNT,
    title: "Automation Context",
    readOnly: true,
    persistence: "session",
    fs: createUnsupportedFileSystem(createReadOnlyFileSystemError, {
      readFile: async (path) => files.get(path)?.content ?? throwContextPathNotFound("open", path),
      readFileBuffer: async (path) =>
        files.get(path)?.bytes ?? throwContextPathNotFound("open", path),
      stat: async (path) => {
        const file = files.get(path);
        if (file) {
          return {
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            mode: 0o444,
            size: file.bytes.length,
            mtime: now,
          };
        }

        if (path === MOUNT) {
          return {
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            mode: 0o555,
            size: 0,
            mtime: now,
          };
        }

        return throwContextPathNotFound("stat", path);
      },
      readdir: async (path) =>
        path === MOUNT
          ? [...files.keys()].map((filePath) => filePath.slice(`${MOUNT}/`.length))
          : throwContextPathNotFound("scandir", path),
      getAllPaths: () => [MOUNT, ...files.keys()],
    }),
  };
};

/**
 * Creates a writable `/dev` mount with `/dev/null` and `/dev/zero`.
 *
 * `/dev/stdin`, `/dev/stdout`, `/dev/stderr` are intentionally omitted: just-bash
 * treats them as plain files (not wired to the shell's I/O streams), so including
 * them would silently swallow output that the script author meant for stderr/stdout.
 * The standard `>&2` redirection works without these files.
 */
const DEV_ENTRIES = ["null", "zero"] as const;

const createAutomationDevMount = (): ResolvedFileMount => {
  const files = new Map<string, Uint8Array>(
    DEV_ENTRIES.map((name) => [`/dev/${name}`, new Uint8Array(0)]),
  );
  const now = new Date();

  return {
    id: "dev",
    kind: "custom",
    mountPoint: "/dev",
    title: "Device Files",
    readOnly: false,
    persistence: "session",
    fs: createUnsupportedFileSystem(createUnsupportedOperationFileSystemError, {
      readFile: async (path) => TEXT_DECODER.decode(files.get(path) ?? new Uint8Array(0)),
      readFileBuffer: async (path) => files.get(path) ?? new Uint8Array(0),
      writeFile: async (path, content) => {
        if (path === "/dev/null") {
          return;
        }
        files.set(path, typeof content === "string" ? TEXT_ENCODER.encode(content) : content);
      },
      stat: async (path) => ({
        isFile: files.has(path),
        isDirectory: path === "/dev",
        isSymbolicLink: false,
        mode: 0o666,
        size: files.get(path)?.length ?? 0,
        mtime: now,
      }),
      readdir: async () => [...DEV_ENTRIES],
      mkdir: async () => {},
      getAllPaths: () => ["/dev", ...files.keys()],
    }),
  };
};

export const createAutomationExecutionFileSystem = ({
  masterFs,
  contextFiles,
  includeDevMount = false,
}: {
  masterFs: MasterFileSystem;
  contextFiles?: Record<string, string>;
  includeDevMount?: boolean;
}): MasterFileSystem => {
  const baseMounts = masterFs.mounts.filter((mount) => mount.mountPoint !== "/context");
  const executionFs = new MasterFileSystem({ mounts: [...baseMounts] });

  if (contextFiles && Object.keys(contextFiles).length > 0) {
    executionFs.mount(createAutomationContextMount({ contextFiles }));
  }

  if (includeDevMount && !baseMounts.some((mount) => mount.mountPoint === "/dev")) {
    executionFs.mount(createAutomationDevMount());
  }

  return executionFs;
};
