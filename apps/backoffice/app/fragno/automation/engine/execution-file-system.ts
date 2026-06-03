import { createPathNotFoundFileSystemError } from "@/files/fs-errors";
import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import type { ResolvedFileMount } from "@/files/types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Creates a read-only mount containing a single `/context/event.json` file.
 * Uses a plain-object filesystem (no InMemoryFs) to avoid `this`-binding issues
 * when methods are wrapped by `normalizeMountedFileSystem`.
 */
export const createAutomationContextMount = (eventJson: string): ResolvedFileMount => {
  const buf = TEXT_ENCODER.encode(eventJson);
  const now = new Date();
  const EVENT_FILE = "/context/event.json";
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
    fs: normalizeMountedFileSystem(
      {
        readFile: async (path) =>
          path === EVENT_FILE ? eventJson : throwContextPathNotFound("open", path),
        readFileBuffer: async (path) =>
          path === EVENT_FILE ? buf : throwContextPathNotFound("open", path),
        stat: async (path) => {
          if (path === EVENT_FILE) {
            return {
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              mode: 0o444,
              size: buf.length,
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
          path === MOUNT ? ["event.json"] : throwContextPathNotFound("scandir", path),
        getAllPaths: () => [MOUNT, EVENT_FILE],
      },
      { readOnly: true },
    ),
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

export const createAutomationDevMount = (): ResolvedFileMount => {
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
    fs: normalizeMountedFileSystem(
      {
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
      },
      { readOnly: false },
    ),
  };
};

export const createAutomationExecutionFileSystem = ({
  masterFs,
  eventJson,
  includeDevMount = false,
}: {
  masterFs: MasterFileSystem;
  eventJson: string;
  includeDevMount?: boolean;
}): MasterFileSystem => {
  const baseMounts = masterFs.mounts.filter((mount) => mount.mountPoint !== "/context");
  const executionFs = new MasterFileSystem({ mounts: [...baseMounts] });

  executionFs.mount(createAutomationContextMount(eventJson));

  if (includeDevMount && !baseMounts.some((mount) => mount.mountPoint === "/dev")) {
    executionFs.mount(createAutomationDevMount());
  }

  return executionFs;
};
