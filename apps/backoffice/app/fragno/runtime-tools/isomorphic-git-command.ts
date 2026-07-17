import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { IFileSystem } from "just-bash";
import { defineCommand } from "just-bash";

type CommandContext = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CommandHandler = (args: string[], ctx: CommandContext) => Promise<string>;
type NodeFsError = Error & { code?: string; path?: string };
type NodeReadFileOptions = string | { encoding?: string | null };
type NodeWriteFileOptions = string | { encoding?: string };

const DEFAULT_CLONE_DEPTH = 1;
const MAX_CLONE_DEPTH = 50;
const DEFAULT_CLONE_MAX_FILES = 5_000;
const MAX_CLONE_MAX_FILES = 20_000;
const DEFAULT_CLONE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_CLONE_MAX_BYTES = 250 * 1024 * 1024;

const HELP_TEXT = [
  "Usage: isogit <command> [args]",
  "",
  "Convenience commands:",
  "  isogit clone <url> [directory] [--depth <n>] [--ref <ref>] [--max-files <n>] [--max-bytes <n>]",
  `    Defaults: --depth ${DEFAULT_CLONE_DEPTH}, --max-files ${DEFAULT_CLONE_MAX_FILES}, --max-bytes ${DEFAULT_CLONE_MAX_BYTES}`,
  "  isogit status [directory]",
  "",
  "Escape hatch:",
  "  isogit call <non-network-isomorphic-git-function> [json-options]",
  "",
].join("\n");

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({
  stdout: "",
  stderr,
  exitCode,
});

const pathJoin = (base: string, path: string) =>
  path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path}`;

const dirnameFromGitUrl = (url: string) =>
  url
    .split("/")
    .pop()
    ?.replace(/\.git$/, "") || "repo";

const nodeCodeFromMessage = (message: string): string | undefined => {
  if (
    message.includes("ENOENT") ||
    message.includes("no such file or directory") ||
    message.includes("not inside a mounted filesystem")
  ) {
    return "ENOENT";
  }
  if (message.includes("ENOTDIR") || message.includes("not a directory")) {
    return "ENOTDIR";
  }
  if (message.includes("EEXIST") || message.includes("already exists")) {
    return "EEXIST";
  }

  return undefined;
};

const asNodeFsError = (error: unknown, path?: string): NodeFsError => {
  const original = error as { code?: unknown; message?: unknown };
  const message =
    typeof original?.message === "string"
      ? original.message
      : error instanceof Error
        ? error.message
        : String(error);
  const nodeError = new Error(message) as NodeFsError;
  const code = typeof original?.code === "string" ? original.code : nodeCodeFromMessage(message);

  if (code) {
    nodeError.code = code;
  }
  nodeError.path = path;
  return nodeError;
};

const withNodeFsErrors = async <T>(path: string | undefined, operation: () => Promise<T>) => {
  try {
    return await operation();
  } catch (error) {
    throw asNodeFsError(error, path);
  }
};

const createIsomorphicGitFs = (fs: IFileSystem) => {
  const toNodeStatShape = (stat: Awaited<ReturnType<IFileSystem["stat"]>>) => ({
    ...stat,
    ctime: stat.mtime,
    ctimeMs: stat.mtime.valueOf(),
    mtimeMs: stat.mtime.valueOf(),
    isFile: () => stat.isFile,
    isDirectory: () => stat.isDirectory,
    isSymbolicLink: () => stat.isSymbolicLink,
  });

  const toNodeStat = async (path: string) => {
    try {
      return toNodeStatShape(await fs.stat(path));
    } catch (error) {
      throw asNodeFsError(error, path);
    }
  };

  const toNodeLstat = async (path: string) => {
    try {
      return toNodeStatShape(await fs.lstat(path));
    } catch (error) {
      throw asNodeFsError(error, path);
    }
  };

  const readFile = async (path?: string, options?: NodeReadFileOptions) => {
    if (!path) {
      throw asNodeFsError(new Error("ENOENT: no such file or directory"), path);
    }

    const encoding = typeof options === "string" ? options : options?.encoding;
    try {
      if (encoding) {
        return await fs.readFile(path, encoding as Parameters<IFileSystem["readFile"]>[1]);
      }
      return await fs.readFileBuffer(path);
    } catch (error) {
      throw asNodeFsError(error, path);
    }
  };

  return {
    promises: {
      readFile,
      writeFile: (path: string, content: string | Uint8Array, options?: NodeWriteFileOptions) =>
        withNodeFsErrors(path, () =>
          fs.writeFile(path, content, options as Parameters<IFileSystem["writeFile"]>[2]),
        ),
      readdir: (path: string) => withNodeFsErrors(path, () => fs.readdir(path)),
      mkdir: (path: string) => withNodeFsErrors(path, () => fs.mkdir(path, { recursive: true })),
      rmdir: (path: string) => withNodeFsErrors(path, () => fs.rm(path, { recursive: false })),
      unlink: (path: string) => withNodeFsErrors(path, () => fs.rm(path, { force: true })),
      stat: toNodeStat,
      lstat: toNodeLstat,
      readlink: (path: string) => withNodeFsErrors(path, () => fs.readlink(path)),
      symlink: (target: string, path: string) =>
        withNodeFsErrors(path, () => fs.symlink(target, path)),
    },
  };
};

const parseJsonOptions = (input: string | undefined): Record<string, unknown> => {
  if (!input) {
    return {};
  }

  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("isogit options must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
};

const parseFlags = (args: string[]) => {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
};

const stringFlag = (flags: Record<string, string | boolean>, name: string) =>
  typeof flags[name] === "string" ? flags[name] : undefined;

const integerFlag = (
  flags: Record<string, string | boolean>,
  name: string,
  { defaultValue, max }: { defaultValue: number; max: number },
): number => {
  const raw = flags[name];
  if (raw === undefined) {
    return defaultValue;
  }
  if (typeof raw !== "string") {
    throw new Error(`--${name} requires a positive integer value.`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`--${name} must be a positive integer no larger than ${max}.`);
  }

  return parsed;
};

const pathExists = async (fs: IFileSystem, path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const assertPathDoesNotExist = async (fs: IFileSystem, path: string): Promise<void> => {
  if (await pathExists(fs, path)) {
    throw new Error(`Target directory already exists: ${path}`);
  }
};

const assertCloneWithinLimits = async (
  fs: IFileSystem,
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<void> => {
  const pending = [root];
  let files = 0;
  let bytes = 0;

  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = await fs.lstat(path);

    if (stat.isDirectory) {
      for (const entry of await fs.readdir(path)) {
        pending.push(pathJoin(path, entry));
      }
      continue;
    }

    files += 1;
    bytes += stat.size;

    if (files > limits.maxFiles) {
      throw new Error(`Clone exceeded file limit of ${limits.maxFiles}.`);
    }
    if (bytes > limits.maxBytes) {
      throw new Error(`Clone exceeded byte limit of ${limits.maxBytes}.`);
    }
  }
};

const STATUS_MATRIX_SHORT_CODES: Record<string, readonly string[]> = {
  "0:0:0": [],
  "0:0:3": ["AD"],
  "0:2:0": ["??"],
  "0:2:2": ["A "],
  "0:2:3": ["AM"],
  "1:0:0": ["D "],
  "1:0:1": [" D"],
  "1:0:3": ["MD"],
  "1:1:0": ["D ", "??"],
  "1:1:1": [],
  "1:1:3": ["MM"],
  "1:2:0": ["D ", "??"],
  "1:2:1": [" M"],
  "1:2:2": ["M "],
  "1:2:3": ["MM"],
};

const formatStatusMatrix = (matrix: Awaited<ReturnType<typeof git.statusMatrix>>) => {
  const lines = matrix.flatMap(([filepath, head, workdir, stage]) => {
    const codes = STATUS_MATRIX_SHORT_CODES[`${head}:${workdir}:${stage}`] ?? ["??"];
    return codes.map((code) => `${code} ${filepath}`);
  });

  return lines.length ? `${lines.join("\n")}\n` : "nothing to commit, working tree clean\n";
};

const clone: CommandHandler = async (args, ctx) => {
  const { flags, positional } = parseFlags(args);
  const [url, directory] = positional;

  if (!url) {
    throw new Error(
      "usage: isogit clone <url> [directory] [--depth <n>] [--ref <ref>] [--max-files <n>] [--max-bytes <n>]",
    );
  }

  const dir = pathJoin(ctx.cwd, directory ?? dirnameFromGitUrl(url));
  const depth = integerFlag(flags, "depth", {
    defaultValue: DEFAULT_CLONE_DEPTH,
    max: MAX_CLONE_DEPTH,
  });
  const maxFiles = integerFlag(flags, "max-files", {
    defaultValue: DEFAULT_CLONE_MAX_FILES,
    max: MAX_CLONE_MAX_FILES,
  });
  const maxBytes = integerFlag(flags, "max-bytes", {
    defaultValue: DEFAULT_CLONE_MAX_BYTES,
    max: MAX_CLONE_MAX_BYTES,
  });

  await assertPathDoesNotExist(ctx.fs, dir);

  try {
    await git.clone({
      fs: createIsomorphicGitFs(ctx.fs),
      http,
      dir,
      url,
      singleBranch: true,
      depth,
      ref: stringFlag(flags, "ref"),
    });
    await assertCloneWithinLimits(ctx.fs, dir, { maxFiles, maxBytes });
  } catch (error) {
    await ctx.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return `Cloned ${url} into ${dir}\n`;
};

const status: CommandHandler = async (args, ctx) => {
  const { flags, positional } = parseFlags(args);
  const dir = pathJoin(ctx.cwd, positional[0] ?? stringFlag(flags, "dir") ?? ".");

  return formatStatusMatrix(
    await git.statusMatrix({
      fs: createIsomorphicGitFs(ctx.fs),
      dir,
    }),
  );
};

const handlers: Record<string, CommandHandler> = { clone, status };

const NETWORK_CALLS_REQUIRING_BOUNDS = new Set(["clone", "fetch", "pull", "push"]);

const callIsomorphicGit = async (args: string[], ctx: CommandContext) => {
  const [fnName, optionsJson] = args;
  const fn = fnName ? (git as Record<string, unknown>)[fnName] : undefined;
  if (typeof fn !== "function") {
    throw new Error(`unknown isomorphic-git function '${fnName ?? ""}'.`);
  }
  if (NETWORK_CALLS_REQUIRING_BOUNDS.has(fnName)) {
    throw new Error(`isogit call ${fnName} is not supported; use a bounded isogit command.`);
  }

  const result = await fn({
    fs: createIsomorphicGitFs(ctx.fs),
    dir: ctx.cwd,
    ...parseJsonOptions(optionsJson),
  });

  return result === undefined ? "" : `${JSON.stringify(result, null, 2)}\n`;
};

export const isomorphicGitCommand = defineCommand("isogit", async (args, ctx) => {
  const [command, ...rest] = args;

  if (!command || command === "--help") {
    return ok(HELP_TEXT);
  }

  try {
    if (command === "call") {
      return ok(await callIsomorphicGit(rest, ctx));
    }

    const handler = handlers[command];
    if (!handler) {
      return fail(`isogit: unknown command '${command}'.\n`, 2);
    }

    return ok(await handler(rest, ctx));
  } catch (error) {
    return fail(`isogit: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
