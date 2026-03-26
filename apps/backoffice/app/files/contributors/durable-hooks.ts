import type {
  DurableHookQueueEntry,
  DurableHookQueueOptions,
  DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

import { normalizeMountedFileSystem } from "../mounted-file-system";
import { normalizeMountPoint } from "../normalize-path";
import type {
  FileContributor,
  FileEntryDescriptor,
  FilesContext,
  MountedFileSystem,
} from "../types";

const PAGE_SIZE = 200;
const UNKNOWN_MTIME = new Date(0);
const TEXT_ENCODER = new TextEncoder();
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export type DurableHooksContributorOptions = {
  id: string;
  mountPoint: string;
  title: string;
  description?: string;
};

type DurableHooksRuntime = {
  getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse>;
};

type ResolvedEntry = {
  entry: DurableHookQueueEntry;
  day: string;
  fileName: string;
};

const resolveEntry = (entry: DurableHookQueueEntry): ResolvedEntry | null => {
  if (!TERMINAL_STATUSES.has(entry.status)) {
    return null;
  }

  const timestamp = entry.createdAt ?? entry.lastAttemptAt;
  const date = toDate(timestamp);
  const day = date ? formatDay(date) : "unknown";
  const ts = date ? date.toISOString() : "unknown";

  const fileName =
    entry.status === "failed" ? `${ts}_${entry.id}-failed.txt` : `${ts}_${entry.id}.json`;

  return { entry, day, fileName };
};

const entryContent = (entry: DurableHookQueueEntry): string => {
  if (entry.status === "failed") {
    return entry.error ?? "Unknown error";
  }

  return JSON.stringify(entry.payload ?? null, null, 2);
};

export const createDurableHooksFileContributor = (
  options: DurableHooksContributorOptions,
): FileContributor => {
  const fileRoot = normalizeMountPoint(options.mountPoint);

  return {
    id: options.id,
    kind: "custom",
    mountPoint: options.mountPoint,
    title: options.title,
    readOnly: true,
    persistence: "ephemeral",
    description:
      options.description ??
      `Read-only terminal hook events for ${options.title}. Organized by day with JSON (completed) or text (failed) files.`,
    createFileSystem(ctx) {
      const runtime = resolveRuntime(ctx, options.id);
      if (!runtime) {
        return null;
      }

      const loadResolved = async (): Promise<ResolvedEntry[]> => {
        const entries = await loadHookEntries(runtime);
        const resolved: ResolvedEntry[] = [];
        for (const entry of entries.values()) {
          const r = resolveEntry(entry);
          if (r) {
            resolved.push(r);
          }
        }
        resolved.sort((a, b) => {
          const aTime = toDate(a.entry.createdAt) ?? UNKNOWN_MTIME;
          const bTime = toDate(b.entry.createdAt) ?? UNKNOWN_MTIME;
          return bTime.getTime() - aTime.getTime();
        });
        return resolved;
      };

      const getDayEntries = async (day: string): Promise<ResolvedEntry[]> => {
        return (await loadResolved()).filter((r) => r.day === day);
      };

      const getDays = async (): Promise<string[]> => {
        const days = new Set<string>();
        for (const r of await loadResolved()) {
          days.add(r.day);
        }
        return [...days].sort().reverse();
      };

      const findByPath = async (
        normalizedPath: string,
      ): Promise<
        | { kind: "root" }
        | { kind: "day"; day: string }
        | { kind: "file"; resolved: ResolvedEntry }
        | null
      > => {
        if (normalizedPath === fileRoot) {
          return { kind: "root" };
        }

        const remainder = normalizedPath.slice(fileRoot.length + 1);
        if (!remainder) {
          return null;
        }

        const slashIdx = remainder.indexOf("/");
        if (slashIdx === -1) {
          const days = await getDays();
          return days.includes(remainder) ? { kind: "day", day: remainder } : null;
        }

        const day = remainder.slice(0, slashIdx);
        const fileName = remainder.slice(slashIdx + 1);
        if (fileName.includes("/")) {
          return null;
        }

        const dayEntries = await getDayEntries(day);
        const match = dayEntries.find((r) => r.fileName === fileName);
        return match ? { kind: "file", resolved: match } : null;
      };

      const fileDescriptor = (resolved: ResolvedEntry): FileEntryDescriptor => {
        const content = entryContent(resolved.entry);
        const isFailed = resolved.entry.status === "failed";
        return {
          kind: "file",
          path: `${fileRoot}/${resolved.day}/${resolved.fileName}`,
          title: resolved.fileName,
          sizeBytes: content.length,
          contentType: isFailed ? "text/plain" : "application/json",
          updatedAt:
            toDate(resolved.entry.lastAttemptAt) ??
            toDate(resolved.entry.createdAt) ??
            UNKNOWN_MTIME,
          metadata: {
            hookId: resolved.entry.id,
            hookName: resolved.entry.hookName,
            status: resolved.entry.status,
            attempts: resolved.entry.attempts,
            maxAttempts: resolved.entry.maxAttempts,
          },
        };
      };

      const fs: MountedFileSystem = normalizeMountedFileSystem({
        async describeEntry(path, stat) {
          const normalizedPath = normalizePath(path);
          const found = await findByPath(normalizedPath);

          if (!found) {
            return stat
              ? { kind: stat.isDirectory ? "folder" : ("file" as const), path: normalizedPath }
              : null;
          }

          switch (found.kind) {
            case "root":
              return { kind: "folder", path: fileRoot, updatedAt: UNKNOWN_MTIME };
            case "day":
              return { kind: "folder", path: `${fileRoot}/${found.day}`, updatedAt: UNKNOWN_MTIME };
            case "file":
              return fileDescriptor(found.resolved);
          }
        },
        async exists(path) {
          return (await findByPath(normalizePath(path))) !== null;
        },
        async stat(path) {
          const normalizedPath = normalizePath(path);
          const found = await findByPath(normalizedPath);
          if (!found) {
            throw new Error("Path not found.");
          }

          if (found.kind === "root" || found.kind === "day") {
            return {
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false,
              mode: 0o555,
              size: 0,
              mtime: UNKNOWN_MTIME,
            };
          }

          const content = entryContent(found.resolved.entry);
          return {
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            mode: 0o444,
            size: content.length,
            mtime:
              toDate(found.resolved.entry.lastAttemptAt) ??
              toDate(found.resolved.entry.createdAt) ??
              UNKNOWN_MTIME,
          };
        },
        async readdir(path) {
          const normalizedPath = normalizePath(path);
          const found = await findByPath(normalizedPath);
          if (!found || found.kind === "file") {
            return [];
          }

          if (found.kind === "root") {
            return getDays();
          }

          return (await getDayEntries(found.day)).map((r) => r.fileName);
        },
        async readdirWithFileTypes(path) {
          const normalizedPath = normalizePath(path);
          const found = await findByPath(normalizedPath);
          if (!found || found.kind === "file") {
            return [];
          }

          if (found.kind === "root") {
            return (await getDays()).map((day) => ({
              name: day,
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false,
            }));
          }

          return (await getDayEntries(found.day)).map((r) => ({
            name: r.fileName,
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
          }));
        },
        async readFile(path) {
          const found = await findByPath(normalizePath(path));
          if (!found || found.kind !== "file") {
            throw new Error("File not found.");
          }

          return entryContent(found.resolved.entry);
        },
        async readFileBuffer(path) {
          const found = await findByPath(normalizePath(path));
          if (!found || found.kind !== "file") {
            throw new Error("File not found.");
          }

          return TEXT_ENCODER.encode(entryContent(found.resolved.entry));
        },
        getAllPaths() {
          return [fileRoot];
        },
        capabilities: {
          writeFile: false,
          mkdir: false,
          rm: false,
        },
      });

      return { fs };
    },
  };
};

const resolveRuntime = (ctx: FilesContext, contributorId: string): DurableHooksRuntime | null => {
  const match = ctx.durableHooksRuntimes?.find((r) => r.contributorId === contributorId);
  return match ?? null;
};

const loadHookEntries = async (
  runtime: DurableHooksRuntime,
): Promise<Map<string, DurableHookQueueEntry>> => {
  const page = await runtime.getHookQueue({ pageSize: PAGE_SIZE });
  const map = new Map<string, DurableHookQueueEntry>();
  for (const item of page.items) {
    map.set(item.id, item);
  }
  return map;
};

const formatDay = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const normalizePath = (path: string): string => {
  const replaced = path.trim().replaceAll("\\", "/");
  const normalized = replaced.startsWith("/") ? replaced : `/${replaced}`;

  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }

  return normalized;
};

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const automationHooksFileContributor = createDurableHooksFileContributor({
  id: "durable-hooks-automation",
  mountPoint: "/events",
  title: "Automation Hooks",
});
