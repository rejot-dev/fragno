import * as babel from "@babel/core";
import { parse } from "@babel/parser";
import { generate } from "@babel/generator";
import type { GeneratorResult } from "@babel/generator";

import { deadCodeElimination, findReferencedIdentifiers } from "babel-dead-code-elimination";
import { transformMacros } from "./transform-macros";
import { transformDefineRoute } from "./transform-define-route";
import { transformDefineLibrary } from "./transform-define-library";

export const transform = (code: string, id: string, options: { ssr: boolean }): GeneratorResult => {
  const ast = parse(code, { sourceType: "module", plugins: [["typescript", {}]] });

  // - https://github.com/babel/babel/issues/11889
  // - https://github.com/babel/babel/issues/11350#issuecomment-606169054
  // @ts-expect-error `@types/babel__core` is missing types for `File`
  new babel.File({ filename: undefined }, { code, ast });

  const refs = findReferencedIdentifiers(ast);

  transformMacros(ast, options);
  transformDefineRoute(ast, options);
  transformDefineLibrary(ast, options);

  deadCodeElimination(ast, refs);
  return generate(ast, { sourceMaps: true, sourceFileName: id }, code);
};
