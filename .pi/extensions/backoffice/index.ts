import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { Readable } from "node:stream";

import { Type } from "typebox";

import {
  backofficeErrorMessage,
  connectToBackoffice,
  downloadBackofficeFile,
  executeBackofficeCodemode,
  fetchBackofficeSystemPrompt,
  findBackofficeServers,
  parseBackofficeScope,
  uploadBackofficeWorkspaceFile,
  type BackofficeScope,
} from "@rejot-dev/backoffice-local";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

const BACKOFFICE_SESSION_ENTRY = "backoffice-session";
const BACKOFFICE_TOOL_NAMES = [
  "read",
  "search",
  "execCodeMode",
  "upload",
  "download",
  "localRead",
  "localBash",
  "localEdit",
  "localWrite",
  "localGrep",
  "localFind",
  "localLs",
];
const CLOUD_BACKOFFICE_URL = "https://backoffice.rejot.dev";

type BackofficeSession = {
  baseUrl: string;
  scope: string;
  systemPrompt: string;
};

function isBackofficeSession(value: unknown): value is BackofficeSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as Record<string, unknown>;
  return (
    typeof session["baseUrl"] === "string" &&
    typeof session["scope"] === "string" &&
    typeof session["systemPrompt"] === "string"
  );
}

function findBackofficeSession(ctx: ExtensionContext): BackofficeSession | null {
  for (const entry of ctx.sessionManager.getEntries().toReversed()) {
    if (
      entry.type === "custom" &&
      entry.customType === BACKOFFICE_SESSION_ENTRY &&
      isBackofficeSession(entry.data)
    ) {
      return entry.data;
    }
  }
  return null;
}

async function discoverBackofficeRemotes(): Promise<Array<{ label: string; value: string }>> {
  const localServers = await findBackofficeServers();
  return [
    { label: "Backoffice Cloud (backoffice.rejot.dev)", value: CLOUD_BACKOFFICE_URL },
    ...localServers.map(({ baseUrl }) => ({
      label: `Local Backoffice (${baseUrl})`,
      value: baseUrl,
    })),
  ];
}

function unwrapCodemodeResult(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }
  return (response as Record<string, unknown>)["result"] ?? response;
}

type BackofficeToolOutputDetails = {
  truncated: boolean;
  returnedLines: number;
  totalLines: number;
  returnedBytes: number;
  totalBytes: number;
  continuation: Record<string, unknown> | null;
};

function serializeBackofficeToolOutput(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2) ?? String(result);
}

function boundBackofficeToolOutput(
  result: unknown,
  continuationForReturnedLines:
    | ((returnedLines: number) => Record<string, unknown>)
    | Record<string, unknown>
    | null,
): { text: string; details: BackofficeToolOutputDetails } {
  const output = serializeBackofficeToolOutput(result);
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const continuation =
    typeof continuationForReturnedLines === "function"
      ? continuationForReturnedLines(truncation.outputLines)
      : continuationForReturnedLines;
  const details = {
    truncated: truncation.truncated,
    returnedLines: truncation.outputLines,
    totalLines: truncation.totalLines,
    returnedBytes: truncation.outputBytes,
    totalBytes: truncation.totalBytes,
    continuation,
  };
  if (!truncation.truncated) {
    return { text: truncation.content, details };
  }

  const continuationMessage = continuation
    ? ` Continue with: ${JSON.stringify(continuation)}.`
    : " The complete result is not stored in the Pi session; request a smaller result.";
  return {
    text:
      `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ` +
      `${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ` +
      `${formatSize(truncation.totalBytes)}).${continuationMessage}]`,
    details,
  };
}

function backofficeWorkspaceFileKey(destinationPath: string): string {
  if (destinationPath.startsWith("/") && !destinationPath.startsWith("/workspace/")) {
    throw new Error("Upload destination must be a file path inside /workspace.");
  }
  const normalized = posix.normalize(destinationPath.replace(/^\/workspace\//, ""));
  const fileKey = normalized.replace(/^\/+/, "");
  if (!fileKey || fileKey === "." || fileKey.startsWith("../")) {
    throw new Error("Upload destination must be a file path inside /workspace.");
  }
  return fileKey;
}

function findSearchContinuation(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const searchResult = result as Record<string, unknown>;
  const cursor: Record<string, string> = {};
  for (const source of ["upload", "static"]) {
    const page = searchResult[source];
    if (
      page &&
      typeof page === "object" &&
      typeof (page as Record<string, unknown>)["cursor"] === "string"
    ) {
      cursor[source] = (page as Record<string, string>)["cursor"];
    }
  }
  return Object.keys(cursor).length > 0 ? { cursor } : null;
}

async function executeBackofficeCode(
  session: BackofficeSession,
  code: string,
  signal?: AbortSignal,
  dependencies?: Record<string, string>,
): Promise<unknown> {
  return unwrapCodemodeResult(
    await executeBackofficeCodemode({
      baseUrl: session.baseUrl,
      scope: parseBackofficeScope(session.scope),
      code,
      ...(dependencies ? { dependencies } : {}),
      ...(signal ? { signal } : {}),
    }),
  );
}

/** Registers `/backoffice` and tools for Backoffice state, local files, search, and codemode. */
export default function registerBackofficeExtension(pi: ExtensionAPI) {
  let toolsRegistered = false;

  function registerBackofficeTools(cwd: string) {
    if (toolsRegistered) {
      return;
    }
    toolsRegistered = true;

    const localRead = createReadToolDefinition(cwd);
    pi.registerTool({
      ...localRead,
      name: "localRead",
      label: "Local Read",
      description: `Read from the local filesystem relative to ${cwd}. ${localRead.description}`,
    });
    const localBash = createBashToolDefinition(cwd);
    pi.registerTool({
      ...localBash,
      name: "localBash",
      label: "Local Bash",
      description: `Run a local shell command from ${cwd}. ${localBash.description}`,
    });
    const localEdit = createEditToolDefinition(cwd);
    pi.registerTool({
      ...localEdit,
      name: "localEdit",
      label: "Local Edit",
      description: `Edit a local file relative to ${cwd}. ${localEdit.description}`,
    });
    const localWrite = createWriteToolDefinition(cwd);
    pi.registerTool({
      ...localWrite,
      name: "localWrite",
      label: "Local Write",
      description: `Write a local file relative to ${cwd}. ${localWrite.description}`,
    });
    const localGrep = createGrepToolDefinition(cwd);
    pi.registerTool({
      ...localGrep,
      name: "localGrep",
      label: "Local Grep",
      description: `Search local file contents relative to ${cwd}. ${localGrep.description}`,
    });
    const localFind = createFindToolDefinition(cwd);
    pi.registerTool({
      ...localFind,
      name: "localFind",
      label: "Local Find",
      description: `Find local files relative to ${cwd}. ${localFind.description}`,
    });
    const localLs = createLsToolDefinition(cwd);
    pi.registerTool({
      ...localLs,
      name: "localLs",
      label: "Local LS",
      description: `List local files relative to ${cwd}. ${localLs.description}`,
    });

    pi.registerTool({
      name: "read",
      label: "Read",
      description: `Read a file from the active Backoffice scope. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; use offset to continue.`,
      parameters: Type.Object({
        path: Type.String({ description: "Absolute or scope-relative file path." }),
        offset: Type.Optional(Type.Number({ description: "First line to return, starting at 1." })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = findBackofficeSession(ctx);
        if (!session) {
          throw new Error("Run /backoffice before using Backoffice tools.");
        }
        const result = await executeBackofficeCode(
          session,
          `async () => { const text = await state.readFile({ path: ${JSON.stringify(params.path)} }); const lines = text.split("\\n"); const start = ${params.offset ?? 1} - 1; return lines.slice(start, ${params.limit === undefined ? "undefined" : `start + ${params.limit}`}).join("\\n"); }`,
          signal,
        );
        const output = boundBackofficeToolOutput(result, (returnedLines) => ({
          offset: (params.offset ?? 1) + returnedLines,
        }));
        return {
          content: [{ type: "text", text: output.text }],
          details: output.details,
        };
      },
    });

    pi.registerTool({
      name: "upload",
      label: "Upload",
      description:
        "Upload one local file into the persistent /workspace filesystem of the active Backoffice scope.",
      parameters: Type.Object({
        localPath: Type.String({
          description: "Local file path, relative to the Pi working directory or absolute.",
        }),
        destinationPath: Type.String({
          description: "Destination path inside Backoffice /workspace.",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = findBackofficeSession(ctx);
        if (!session) {
          throw new Error("Run /backoffice before using Backoffice tools.");
        }
        const sourcePath = resolve(cwd, params.localPath);
        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) {
          throw new Error(`Local upload source is not a file: ${sourcePath}`);
        }
        const fileKey = backofficeWorkspaceFileKey(params.destinationPath);
        const result = await uploadBackofficeWorkspaceFile({
          baseUrl: session.baseUrl,
          scope: parseBackofficeScope(session.scope),
          fileKey,
          content: Readable.toWeb(createReadStream(sourcePath)) as ReadableStream<Uint8Array>,
          sizeBytes: sourceStat.size,
          contentType: "application/octet-stream",
          signal,
        });
        const output = boundBackofficeToolOutput(result, null);
        return {
          content: [{ type: "text", text: output.text }],
          details: output.details,
        };
      },
    });

    pi.registerTool({
      name: "download",
      label: "Download",
      description:
        "Download one file from the active Backoffice scope's filesystem to the local filesystem, including /workspace and /static files.",
      parameters: Type.Object({
        sourcePath: Type.String({ description: "Absolute Backoffice file path." }),
        localPath: Type.String({
          description: "Local destination path, relative to the Pi working directory or absolute.",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = findBackofficeSession(ctx);
        if (!session) {
          throw new Error("Run /backoffice before using Backoffice tools.");
        }
        const sourcePath = posix.normalize(params.sourcePath);
        const localPath = resolve(cwd, params.localPath);
        const content = await withFileMutationQueue(localPath, async () => {
          const downloaded = await downloadBackofficeFile({
            baseUrl: session.baseUrl,
            scope: parseBackofficeScope(session.scope),
            path: sourcePath,
            signal,
          });
          await mkdir(dirname(localPath), { recursive: true });
          await writeFile(localPath, downloaded);
          return downloaded;
        });
        return {
          content: [
            {
              type: "text",
              text: `Downloaded ${sourcePath} to ${localPath} (${formatSize(content.byteLength)}).`,
            },
          ],
          details: {
            sourcePath,
            localPath,
            bytesWritten: content.byteLength,
          },
        };
      },
    });

    pi.registerTool({
      name: "search",
      label: "Search",
      description: `Search file contents in the active Backoffice scope. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; use returned cursors to continue.`,
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Text to search for." }),
        glob: Type.Optional(Type.String({ description: "File glob. Defaults to all files." })),
        caseSensitive: Type.Optional(Type.Boolean()),
        wholeWord: Type.Optional(Type.Boolean()),
        contextBefore: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
        contextAfter: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
        maxMatches: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(
          Type.Object({
            upload: Type.Optional(Type.String()),
            static: Type.Optional(Type.String()),
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = findBackofficeSession(ctx);
        if (!session) {
          throw new Error("Run /backoffice before using Backoffice tools.");
        }
        const result = await executeBackofficeCode(
          session,
          `async () => await state.searchFiles(${JSON.stringify({
            pattern: params.glob ?? "**",
            query: params.query,
            caseSensitive: params.caseSensitive,
            wholeWord: params.wholeWord,
            contextBefore: params.contextBefore,
            contextAfter: params.contextAfter,
            maxMatches: params.maxMatches ?? 50,
            cursor: params.cursor,
          })})`,
          signal,
        );
        const output = boundBackofficeToolOutput(result, findSearchContinuation(result));
        return {
          content: [{ type: "text", text: output.text }],
          details: output.details,
        };
      },
    });

    pi.registerTool({
      name: "execCodeMode",
      label: "Exec Code Mode",
      description: `Execute one top-level codemode program against the active Backoffice scope. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; return a smaller projection when truncated.`,
      parameters: Type.Object({
        code: Type.String({
          minLength: 1,
          description: "An async arrow function or defineWorkflow program.",
        }),
        dependencies: Type.Optional(
          Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 })),
        ),
      }),
      renderCall(args, theme, context) {
        const container = new Container();
        const dependencyCount = args.dependencies ? Object.keys(args.dependencies).length : 0;
        const dependencySummary =
          dependencyCount > 0
            ? theme.fg(
                "muted",
                ` · ${dependencyCount} ${dependencyCount === 1 ? "dependency" : "dependencies"}`,
              )
            : "";
        container.addChild(
          new Text(
            `${theme.fg("toolTitle", theme.bold("execCodeMode"))}${dependencySummary}`,
            0,
            0,
          ),
        );

        const codeLines = args.code.split("\n");
        const visibleLines = context.expanded ? codeLines : codeLines.slice(0, 30);
        const hiddenLineCount = codeLines.length - visibleLines.length;
        const fence = args.code.includes("````") ? "`````" : "````";
        container.addChild(
          new Markdown(
            `${fence}javascript\n${visibleLines.join("\n")}\n${fence}`,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
        if (hiddenLineCount > 0) {
          container.addChild(
            new Text(theme.fg("dim", `… ${hiddenLineCount} more lines (expand to view)`), 0, 0),
          );
        }
        return container;
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = findBackofficeSession(ctx);
        if (!session) {
          throw new Error("Run /backoffice before using Backoffice tools.");
        }
        const result = await executeBackofficeCode(
          session,
          params.code,
          signal,
          params.dependencies,
        );
        const output = boundBackofficeToolOutput(result, null);
        return {
          content: [{ type: "text", text: output.text }],
          details: output.details,
        };
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    const session = findBackofficeSession(ctx);
    if (!session) {
      return;
    }
    registerBackofficeTools(ctx.cwd);
    pi.setActiveTools(BACKOFFICE_TOOL_NAMES);
    ctx.ui.setStatus("backoffice", `backoffice:${new URL(session.baseUrl).host}`);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const session = findBackofficeSession(ctx);
    return session ? { systemPrompt: session.systemPrompt } : undefined;
  });

  pi.registerCommand("backoffice", {
    description: "Start a Backoffice-powered session",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/backoffice requires an interactive UI.", "error");
        return;
      }
      try {
        const remotes = await discoverBackofficeRemotes();
        const remoteLabel = await ctx.ui.select(
          "Choose a Backoffice remote",
          remotes.map((remote) => remote.label),
        );
        const baseUrl = remotes.find((remote) => remote.label === remoteLabel)?.value;
        if (!baseUrl) {
          return;
        }

        ctx.ui.notify("Checking stored Backoffice authentication…", "info");
        const connection = await connectToBackoffice({
          baseUrl,
          openBrowser: true,
          onDeviceAuthorization: ({ verificationUrl, userCode }) => {
            ctx.ui.notify("Starting Backoffice browser authentication…", "info");
            ctx.ui.notify(`Open ${verificationUrl}`, "info");
            ctx.ui.notify(`Enter code: ${userCode}`, "info");
            ctx.ui.notify("Waiting for approval…", "info");
          },
        });
        const organizations = connection.summary.organizations ?? [];
        const scopeChoices: Array<{ label: string; scope: string }> = [];
        if (connection.summary.user.role === "admin") {
          scopeChoices.push({ label: "System", scope: "system" });
        }
        for (const organization of organizations) {
          const organizationLabel = `${organization.name ?? organization.id} (${organization.id})`;
          scopeChoices.push({
            label: `Organization · ${organizationLabel}`,
            scope: `org:${encodeURIComponent(organization.id)}`,
          });
        }
        if (scopeChoices.length === 0) {
          throw new Error("The authenticated user has no available Backoffice scopes.");
        }

        const scopeLabel = await ctx.ui.select(
          "Choose a Backoffice scope",
          scopeChoices.map((choice) => choice.label),
        );
        const scope = scopeChoices.find((choice) => choice.label === scopeLabel)?.scope;
        if (!scope) {
          return;
        }

        const parsedScope: BackofficeScope = parseBackofficeScope(scope);
        const systemPrompt = await fetchBackofficeSystemPrompt({
          baseUrl,
          scope: parsedScope,
        });
        await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile(),
          setup: async (sessionManager) => {
            sessionManager.appendCustomEntry(BACKOFFICE_SESSION_ENTRY, {
              baseUrl,
              scope,
              systemPrompt,
            });
          },
          withSession: async (newContext) => {
            newContext.ui.notify(`Connected to ${baseUrl} with scope ${scope}.`, "info");
          },
        });
      } catch (error) {
        ctx.ui.notify(`Backoffice setup failed: ${backofficeErrorMessage(error)}`, "error");
      }
    },
  });
}
