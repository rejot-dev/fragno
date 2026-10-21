import { posix } from "node:path";

import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import jsTokens from "js-tokens";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";

/** Saved JavaScript lives in these mounts, so a program imports only from them. */
const SOURCE_MODULE_ROOTS = ["/static/", "/workspace/"] as const;

/** A program's saved modules, transitively, and the packages only a compiler can resolve. */
export type SavedModuleImports = {
  /** Source by absolute path; a saved program's own file is included. */
  modules: Record<string, string>;
  packages: string[];
};

/** Names the import a program cannot load, so checks can point at it. */
export class SavedModuleImportError extends BackofficeOperationError {
  constructor(
    readonly path: string | null,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super("invalid_request", message);
    this.name = "SavedModuleImportError";
  }
}

/**
 * workerd reports an import a program was not given as `No such module "workspace/x.js".`, which
 * reads as a missing file. Saved modules reach a program only through imports found before it
 * runs, so the message explains how to import one; null leaves other messages as they are.
 */
export function explainUnloadedSavedModule(message: string): string | null {
  const name = /^No such module "([^"]+)"\.?$/u.exec(message)?.[1];
  const path = name === undefined ? null : `/${name}`;
  if (path === null || !SOURCE_MODULE_ROOTS.some((root) => path.startsWith(root))) {
    return null;
  }
  return `Import "${path}" was not loaded. A program imports saved modules found before it runs, so name the path as a string literal, such as import(${JSON.stringify(path)}), and import a module in a later call than the one that writes it.`;
}

type ImportSpecifier = {
  specifier: string;
  /** Static imports and re-exports belong to modules; dynamic imports work in any code. */
  form: "static" | "dynamic";
  line: number;
  column: number;
};

/**
 * Finds static imports, re-exports, and dynamic imports of string literals. Other dynamic imports
 * cannot be resolved before execution; they fail when they run, as `explainUnloadedSavedModule`
 * describes.
 */
function findImportSpecifiers(code: string): ImportSpecifier[] {
  let offset = 0;
  const tokens = [...jsTokens(code)]
    .map((token) => {
      const start = offset;
      offset += token.value.length;
      return { token, start };
    })
    .filter(
      ({ token }) =>
        token.type !== "WhiteSpace" &&
        token.type !== "LineTerminatorSequence" &&
        token.type !== "SingleLineComment" &&
        token.type !== "MultiLineComment" &&
        token.type !== "HashbangComment",
    );
  const specifiers: ImportSpecifier[] = [];
  for (const [index, { token }] of tokens.entries()) {
    const previous = tokens[index - 1]?.token;
    if (token.type !== "IdentifierName" || previous?.value === "." || previous?.value === "?.") {
      continue;
    }
    const next = tokens[index + 1];
    const staticLiteral =
      (token.value === "from" || token.value === "import") && next?.token.type === "StringLiteral"
        ? next
        : null;
    const literal =
      staticLiteral ??
      (token.value === "import" &&
      next?.token.value === "(" &&
      tokens[index + 2]?.token.type === "StringLiteral" &&
      [")", ","].includes(tokens[index + 3]?.token.value ?? "")
        ? tokens[index + 2]
        : null);
    if (literal) {
      const lines = code.slice(0, literal.start).split(/\r\n|[\n\r\u2028\u2029]/u);
      specifiers.push({
        specifier: literal.token.value.slice(1, -1),
        form: staticLiteral ? "static" : "dynamic",
        line: lines.length,
        column: (lines.at(-1)?.length ?? 0) + 1,
      });
    }
  }
  return specifiers;
}

/**
 * Reads the saved modules a program imports, following path specifiers from module to module.
 * Inline code is one expression with no location, so it imports saved modules dynamically and by
 * absolute path only. Saved files, including workflows, are modules.
 */
export async function readSavedModuleImports(input: {
  readFile: (path: string) => Promise<string>;
  program: { kind: "inline"; code: string } | { kind: "file"; path: string };
}): Promise<SavedModuleImports> {
  const modules: Record<string, string> = {};
  const packages = new Set<string>();
  let sourceBytes = 0;

  function addModule(path: string, code: string, fail: (message: string) => Error) {
    sourceBytes += new TextEncoder().encode(code).byteLength;
    if (sourceBytes > CODEMODE_LIMITS.maxSourceBytes) {
      throw fail("CODEMODE_SOURCE_LIMIT_EXCEEDED");
    }
    modules[path] = code;
  }

  async function readImportedModule(
    path: string,
    imported: ImportSpecifier,
    importer: string | null,
  ) {
    const fail = (message: string) =>
      new SavedModuleImportError(importer, imported.line, imported.column, message);
    if (!SOURCE_MODULE_ROOTS.some((root) => path.startsWith(root)) || !path.endsWith(".js")) {
      throw fail(
        `Import '${imported.specifier}' must name a .js file under /workspace or /static.`,
      );
    }
    let code: string;
    try {
      code = await input.readFile(path);
    } catch (error) {
      throw fail(
        `Import '${imported.specifier}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    addModule(path, code, fail);
    await followImports(code, path);
  }

  async function followImports(code: string, importer: string | null) {
    for (const imported of findImportSpecifiers(code)) {
      const { specifier } = imported;
      if (importer === null && imported.form === "static") {
        // The guest wraps inline code in an expression, where a static import does not compile.
        throw new SavedModuleImportError(
          null,
          imported.line,
          imported.column,
          `Inline code is one expression, so it loads modules with \`await import(${JSON.stringify(specifier)})\` instead of a static import.`,
        );
      }
      if (!specifier.startsWith("/") && !specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      let path: string;
      if (specifier.startsWith("/")) {
        path = posix.normalize(specifier);
      } else if (importer === null) {
        throw new SavedModuleImportError(
          null,
          imported.line,
          imported.column,
          `Inline code imports saved modules by absolute path, not '${specifier}'.`,
        );
      } else {
        path = posix.join(posix.dirname(importer), specifier);
      }
      if (!Object.hasOwn(modules, path)) {
        await readImportedModule(path, imported, importer);
      }
    }
  }

  if (input.program.kind === "inline") {
    await followImports(input.program.code, null);
  } else {
    const { path } = input.program;
    const code = await input.readFile(path);
    addModule(path, code, (message) => new SavedModuleImportError(path, 1, 1, message));
    await followImports(code, path);
  }
  return { modules, packages: [...packages] };
}
