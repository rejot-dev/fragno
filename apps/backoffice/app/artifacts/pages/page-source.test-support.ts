import * as ts from "typescript";

import { STATIC_CODEMODE_CONTENT } from "@/files/content/static-codemode";

/**
 * Type-checks a page source saved at `path` against the static codemode declarations with
 * js.check's options; scenarios have no compiler service to run js.check itself.
 */
export function checkPageSource(path: string, source: string): string[] {
  const files = new Map<string, string>([
    ...Object.entries(STATIC_CODEMODE_CONTENT).map(
      ([staticPath, content]) => [`/static/${staticPath}`, String(content)] as const,
    ),
    [path, source] as const,
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram([...files.keys()], options, {
    ...host,
    fileExists: (name) => files.has(name) || host.fileExists(name),
    readFile: (name) => files.get(name) ?? host.readFile(name),
    getSourceFile: (name, languageVersion, onError) => {
      const content = files.get(name);
      return content === undefined
        ? host.getSourceFile(name, languageVersion, onError)
        : ts.createSourceFile(name, content, languageVersion);
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
