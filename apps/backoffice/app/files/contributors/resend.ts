import type { ResendThreadMessage, ResendThreadSummary } from "@fragno-dev/resend-fragment";

import {
  NotConfiguredError,
  buildResendThreadMarkdown,
  createRouteBackedResendRuntime,
  type ResendBashRuntime,
} from "@/fragno/bash-runtime/resend-bash-runtime";

import { normalizeMountedFileSystem } from "../mounted-file-system";
import { normalizeMountPoint } from "../normalize-path";
import type {
  FileContributor,
  FileEntryDescriptor,
  FileMountMetadata,
  FilesContext,
  MountedFileSystem,
} from "../types";

export const RESEND_FILE_CONTRIBUTOR_ID = "resend";
export const RESEND_FILE_MOUNT_ID = "resend";
export const RESEND_FILE_MOUNT_POINT = "/resend";

const PAGE_SIZE = 100;
const UNKNOWN_MTIME = new Date(0);
const TEXT_ENCODER = new TextEncoder();

export const resendFileMount: FileMountMetadata = {
  id: RESEND_FILE_MOUNT_ID,
  kind: "custom",
  mountPoint: RESEND_FILE_MOUNT_POINT,
  title: "Resend",
  readOnly: true,
  persistence: "ephemeral",
  description:
    "Read-only email thread snapshots from the Resend fragment. One Markdown file per thread.",
};

const FILE_ROOT = normalizeMountPoint(RESEND_FILE_MOUNT_POINT);

export const resendFileContributor: FileContributor = {
  ...resendFileMount,
  createFileSystem(ctx) {
    const runtime = createResendRuntime(ctx);
    if (!runtime) {
      return null;
    }

    const getThreadIndex = async (): Promise<Map<string, ResendThreadSummary>> => {
      try {
        return await loadAllThreadSummaries(runtime);
      } catch (error) {
        if (error instanceof NotConfiguredError) {
          return new Map();
        }

        throw error;
      }
    };

    const getThreadContent = async (thread: ResendThreadSummary): Promise<string> => {
      try {
        const messages = await fetchThreadMessages(runtime, thread.id);
        return buildResendThreadMarkdown(thread, messages);
      } catch (error) {
        if (error instanceof NotConfiguredError) {
          return "";
        }

        throw error;
      }
    };

    const listThreads = async (): Promise<ResendThreadSummary[]> => {
      const allThreads = [...(await getThreadIndex()).values()];
      allThreads.sort((left, right) => {
        const leftDate = toDate(right.lastMessageAt) ?? toDate(right.createdAt) ?? UNKNOWN_MTIME;
        const rightDate = toDate(left.lastMessageAt) ?? toDate(left.createdAt) ?? UNKNOWN_MTIME;
        return leftDate.getTime() - rightDate.getTime();
      });

      return allThreads;
    };

    const getThreadByPath = async (path: string): Promise<ResendThreadSummary | null> => {
      const threadId = parseThreadIdFromPath(path);
      if (!threadId) {
        return null;
      }

      const index = await getThreadIndex();
      return index.get(threadId) ?? null;
    };

    const fs: MountedFileSystem = normalizeMountedFileSystem({
      async describeEntry(path, stat) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath === FILE_ROOT) {
          return {
            kind: "folder",
            path: FILE_ROOT,
            updatedAt: UNKNOWN_MTIME,
          };
        }

        const thread = await getThreadByPath(normalizedPath);
        if (!thread) {
          return stat
            ? {
                kind: stat.isDirectory ? "folder" : "file",
                path: normalizedPath,
              }
            : null;
        }

        return threadDescriptor(thread);
      },
      async exists(path) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath === FILE_ROOT) {
          return true;
        }

        const thread = await getThreadByPath(normalizedPath);
        return thread !== null;
      },
      async stat(path) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath === FILE_ROOT) {
          return {
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            mode: 0o555,
            size: 0,
            mtime: UNKNOWN_MTIME,
          };
        }

        const thread = await getThreadByPath(normalizedPath);
        if (!thread) {
          throw new Error("Path not found.");
        }

        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o444,
          size: thread.messageCount * 120,
          mtime:
            toDate(thread.lastMessageAt) ??
            toDate(thread.updatedAt) ??
            toDate(thread.createdAt) ??
            UNKNOWN_MTIME,
        };
      },
      async readdir(path) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath !== FILE_ROOT) {
          return [];
        }

        return (await listThreads()).map((thread) => threadFileName(thread.id));
      },
      async readdirWithFileTypes(path) {
        const normalizedPath = normalizePath(path);
        if (normalizedPath !== FILE_ROOT) {
          return [];
        }

        const threads = await listThreads();
        return threads.map((thread) => ({
          name: threadFileName(thread.id),
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        }));
      },
      async readFile(path) {
        const normalizedPath = normalizePath(path);
        const thread = await getThreadByPath(normalizedPath);
        if (!thread) {
          throw new Error("File not found.");
        }

        return getThreadContent(thread);
      },
      async readFileBuffer(path) {
        const content = await getThreadByPath(normalizePath(path));
        if (!content) {
          throw new Error("File not found.");
        }

        const markdown = await getThreadContent(content);
        return TEXT_ENCODER.encode(markdown);
      },
      getAllPaths() {
        return [FILE_ROOT];
      },
      capabilities: {
        writeFile: false,
        mkdir: false,
        rm: false,
      },
    });

    const threadDescriptor = (thread: ResendThreadSummary): FileEntryDescriptor => {
      return {
        kind: "file",
        path: threadFilePath(thread.id),
        title: thread.subject ?? `Thread ${thread.id}`,
        sizeBytes: thread.messageCount * 120,
        contentType: "text/markdown",
        updatedAt:
          toDate(thread.lastMessageAt) ??
          toDate(thread.updatedAt) ??
          toDate(thread.createdAt) ??
          UNKNOWN_MTIME,
        metadata: {
          threadId: thread.id,
          subject: thread.subject,
          participants: thread.participants,
          messageCount: thread.messageCount,
          lastDirection: thread.lastDirection,
        },
      };
    };

    return {
      fs,
    };
  },
};

const createResendRuntime = (ctx: FilesContext): ResendBashRuntime | null => {
  if (!ctx.resendRuntime) {
    return null;
  }

  return createRouteBackedResendRuntime({
    baseUrl: ctx.resendRuntime.baseUrl ?? ctx.origin ?? "https://resend.runtime",
    headers: ctx.resendRuntime.headers,
    fetch: ctx.resendRuntime.fetch,
  });
};

const loadAllThreadSummaries = async (
  runtime: ResendBashRuntime,
): Promise<Map<string, ResendThreadSummary>> => {
  const map = new Map<string, ResendThreadSummary>();
  let cursor: string | undefined;

  while (true) {
    const payload = await runtime.listThreads({
      order: "desc",
      pageSize: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const thread of payload.threads) {
      map.set(thread.id, thread);
    }

    if (!payload.hasNextPage || !payload.cursor) {
      break;
    }

    cursor = payload.cursor;
  }

  return map;
};

const fetchThreadMessages = async (
  runtime: ResendBashRuntime,
  threadId: string,
): Promise<ResendThreadMessage[]> => {
  const messages: ResendThreadMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const payload = await runtime.listThreadMessages({
      threadId,
      order: "asc",
      pageSize: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    messages.push(...payload.messages);

    if (!payload.hasNextPage || !payload.cursor) {
      break;
    }

    cursor = payload.cursor;
  }

  return messages;
};

const parseThreadIdFromPath = (path: string): string | null => {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === FILE_ROOT || !normalizedPath.startsWith(`${FILE_ROOT}/`)) {
    return null;
  }

  const leaf = normalizedPath.slice(FILE_ROOT.length + 1);
  if (!leaf || leaf.includes("/") || !leaf.endsWith(".md")) {
    return null;
  }

  const encoded = leaf.slice(0, -3);
  if (!encoded) {
    return null;
  }

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

const threadFileName = (threadId: string) => `${encodeURIComponent(threadId)}.md`;

const threadFilePath = (threadId: string) => `${FILE_ROOT}/${threadFileName(threadId)}`;

const normalizePath = (path: string): string => {
  const replaced = path.trim().replaceAll("\\", "/");
  const normalized = replaced.startsWith("/") ? replaced : `/${replaced}`;

  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }

  return normalized;
};

const toDate = (value: string | Date | undefined | null): Date | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
