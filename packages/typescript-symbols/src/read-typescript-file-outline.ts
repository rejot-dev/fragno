import { readFile } from "node:fs/promises";

import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";

const MAX_ANONYMOUS_FUNCTION_DEPTH = 2;

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type OutlineEntry = {
  text: string;
  children: OutlineEntry[];
};

type FunctionOutlinePresentation = {
  text: string;
  isAnonymous: boolean;
};

type ActiveFunctionOutline = {
  isAnonymous: boolean;
  hasOutlineEntry: boolean;
};

function astNode(value: unknown): AstNode {
  return value as AstNode;
}

function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const node = value as Record<string, unknown>;
  return (
    typeof node["type"] === "string" &&
    typeof node["start"] === "number" &&
    typeof node["end"] === "number"
  );
}

function astNodeProperty(node: AstNode, property: string): AstNode | undefined {
  const value = node[property];
  return isAstNode(value) ? value : undefined;
}

function astNodeArrayProperty(node: AstNode, property: string): AstNode[] {
  const value = node[property];
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}

function collectLiteralRanges(program: Program): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isAstNode(value)) {
      return;
    }

    if (value.type.includes("Literal") || value.type === "TemplateElement") {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    for (const child of Object.values(value)) {
      visit(child);
    }
  }

  visit(program);
  return ranges;
}

function sourceFragment(
  sourceText: string,
  start: number,
  end: number,
  literalRanges: Array<{ start: number; end: number }> = [],
): string {
  const literals: string[] = [];
  let fragment = sourceText.slice(start, end);

  for (const range of literalRanges.toReversed()) {
    if (range.start < start || range.end > end) {
      continue;
    }

    const placeholder = `\u{e000}${literals.length}\u{e001}`;
    literals.push(sourceText.slice(range.start, range.end));
    fragment = `${fragment.slice(0, range.start - start)}${placeholder}${fragment.slice(range.end - start)}`;
  }

  return fragment
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*\.\s*/g, ".")
    .trim()
    .replace(/;$/, "")
    .replaceAll(/\u{e000}(\d+)\u{e001}/gu, (_, index: string) => literals[Number(index)] ?? "");
}

function sourceNode(
  sourceText: string,
  node: AstNode,
  literalRanges: Array<{ start: number; end: number }>,
): string {
  return sourceFragment(sourceText, node.start, node.end, literalRanges);
}

function functionSignature(
  sourceText: string,
  functionNode: AstNode,
  literalRanges: Array<{ start: number; end: number }>,
): string {
  const body = astNodeProperty(functionNode, "body");
  return sourceFragment(
    sourceText,
    functionNode.start,
    body?.start ?? functionNode.end,
    literalRanges,
  );
}

function callablePropertyType(property: AstNode): AstNode | undefined {
  const typeAnnotation = astNodeProperty(property, "typeAnnotation");
  return typeAnnotation ? astNodeProperty(typeAnnotation, "typeAnnotation") : undefined;
}

function rootCallReceiver(
  sourceText: string,
  node: AstNode | undefined,
  literalRanges: Array<{ start: number; end: number }>,
): string | undefined {
  if (!node) {
    return undefined;
  }

  switch (node.type) {
    case "Identifier":
    case "ThisExpression":
    case "Super":
      return sourceNode(sourceText, node, literalRanges);

    case "MemberExpression":
      return rootCallReceiver(sourceText, astNodeProperty(node, "object"), literalRanges);

    case "CallExpression":
    case "NewExpression":
      return rootCallReceiver(sourceText, astNodeProperty(node, "callee"), literalRanges);

    case "ChainExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return rootCallReceiver(sourceText, astNodeProperty(node, "expression"), literalRanges);

    default:
      return undefined;
  }
}

function compactCallCallee(
  sourceText: string,
  call: AstNode,
  literalRanges: Array<{ start: number; end: number }>,
): string {
  const callee = astNodeProperty(call, "callee");
  if (!callee) {
    return "<call>";
  }

  const exactCallee = sourceNode(sourceText, callee, literalRanges);
  if (exactCallee.length <= 60) {
    return exactCallee;
  }

  if (callee.type !== "MemberExpression") {
    return exactCallee;
  }

  const property = astNodeProperty(callee, "property");
  const propertyName = property ? sourceNode(sourceText, property, literalRanges) : "<member>";
  const receiver = rootCallReceiver(sourceText, astNodeProperty(callee, "object"), literalRanges);
  return receiver ? `${receiver}.${propertyName}` : propertyName;
}

function callWithAnonymousFunction(
  sourceText: string,
  call: AstNode,
  functionNode: AstNode,
  argumentIndex: number,
  callArguments: AstNode[],
  literalRanges: Array<{ start: number; end: number }>,
): string {
  const precedingArguments = callArguments
    .slice(0, argumentIndex)
    .map((argument) =>
      argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression"
        ? functionSignature(sourceText, argument, literalRanges)
        : sourceNode(sourceText, argument, literalRanges),
    );
  const argumentsPrefix = precedingArguments.length > 0 ? `${precedingArguments.join(", ")}, ` : "";
  const suffix = argumentIndex === callArguments.length - 1 ? ")" : ", …)";

  return `${compactCallCallee(sourceText, call, literalRanges)}(${argumentsPrefix}${functionSignature(sourceText, functionNode, literalRanges)}${suffix}`;
}

function renderOutlineEntries(entries: OutlineEntry[], depth = 0): string[] {
  return entries.flatMap((outlineEntry) => [
    `${"  ".repeat(depth)}${outlineEntry.text}`,
    ...renderOutlineEntries(outlineEntry.children, depth + 1),
  ]);
}

class TypeScriptOutlineVisitor {
  readonly rootEntries: OutlineEntry[] = [];

  private readonly activeOutlineEntries: Array<{ node: AstNode; entry: OutlineEntry }> = [];
  private readonly activeFunctions = new WeakMap<AstNode, ActiveFunctionOutline>();
  private readonly declarationPrefixes = new WeakMap<AstNode, string>();
  private readonly functionPresentations = new WeakMap<AstNode, FunctionOutlinePresentation>();
  private readonly ignoredFunctionNodes = new WeakSet<AstNode>();
  private readonly outlineEntryNodes = new WeakSet<AstNode>();
  private readonly suppressedSubtreeRoots = new WeakSet<AstNode>();

  private anonymousFunctionDepth = 0;
  private classDepth = 0;
  private functionDepth = 0;
  private suppressedSubtreeDepth = 0;

  private readonly sourceText: string;

  constructor(sourceText: string, literalRanges: Array<{ start: number; end: number }>) {
    this.sourceText = sourceText;
    this.literalRanges = literalRanges;
  }

  private readonly literalRanges: Array<{ start: number; end: number }>;

  visit(program: Program): void {
    /* oxlint-disable typescript/unbound-method -- nodeHandler restores the visitor receiver before invocation. */
    const visitor = new Visitor({
      ExportNamedDeclaration: this.nodeHandler(this.enterExportDeclaration),
      ExportDefaultDeclaration: this.nodeHandler(this.enterExportDeclaration),
      ExportAllDeclaration: this.nodeHandler(this.appendSourceNode),
      ImportDeclaration: this.nodeHandler(this.appendSourceNode),
      TSImportEqualsDeclaration: this.nodeHandler(this.appendSourceNode),
      TSExportAssignment: this.nodeHandler(this.appendSourceNode),
      TSNamespaceExportDeclaration: this.nodeHandler(this.appendSourceNode),

      TSTypeAliasDeclaration: this.nodeHandler(this.enterTypeAliasDeclaration),
      "TSTypeAliasDeclaration:exit": this.nodeHandler(this.leaveSuppressedSubtree),
      TSInterfaceDeclaration: this.nodeHandler(this.enterDeclarationWithBody),
      "TSInterfaceDeclaration:exit": this.nodeHandler(this.leaveOutlineEntry),
      ClassDeclaration: this.nodeHandler(this.enterClass),
      "ClassDeclaration:exit": this.nodeHandler(this.leaveClass),
      ClassExpression: this.nodeHandler(this.enterClass),
      "ClassExpression:exit": this.nodeHandler(this.leaveClass),
      TSModuleDeclaration: this.nodeHandler(this.enterDeclarationWithBody),
      "TSModuleDeclaration:exit": this.nodeHandler(this.leaveOutlineEntry),
      TSEnumDeclaration: this.nodeHandler(this.enterEnumDeclaration),
      "TSEnumDeclaration:exit": this.nodeHandler(this.leaveSuppressedSubtree),

      FunctionDeclaration: this.nodeHandler(this.enterNamedFunction),
      "FunctionDeclaration:exit": this.nodeHandler(this.leaveFunction),
      TSDeclareFunction: this.nodeHandler(this.enterNamedFunction),
      "TSDeclareFunction:exit": this.nodeHandler(this.leaveFunction),
      ArrowFunctionExpression: this.nodeHandler(this.enterFunctionExpression),
      "ArrowFunctionExpression:exit": this.nodeHandler(this.leaveFunction),
      FunctionExpression: this.nodeHandler(this.enterFunctionExpression),
      "FunctionExpression:exit": this.nodeHandler(this.leaveFunction),

      VariableDeclaration: this.nodeHandler(this.enterVariableDeclaration),
      MethodDefinition: this.nodeHandler(this.enterMethod),
      "MethodDefinition:exit": this.nodeHandler(this.leaveOutlineEntry),
      TSAbstractMethodDefinition: this.nodeHandler(this.enterMethod),
      "TSAbstractMethodDefinition:exit": this.nodeHandler(this.leaveOutlineEntry),
      PropertyDefinition: this.nodeHandler(this.enterFunctionProperty),
      "PropertyDefinition:exit": this.nodeHandler(this.leaveOutlineEntry),
      AccessorProperty: this.nodeHandler(this.enterFunctionProperty),
      "AccessorProperty:exit": this.nodeHandler(this.leaveOutlineEntry),
      TSAbstractAccessorProperty: this.nodeHandler(this.enterFunctionProperty),
      "TSAbstractAccessorProperty:exit": this.nodeHandler(this.leaveOutlineEntry),
      Property: this.nodeHandler(this.enterFunctionProperty),
      "Property:exit": this.nodeHandler(this.leaveOutlineEntry),

      TSMethodSignature: this.nodeHandler(this.enterOutlinedTypeMember),
      "TSMethodSignature:exit": this.nodeHandler(this.leaveSuppressedSubtree),
      TSCallSignatureDeclaration: this.nodeHandler(this.enterOutlinedTypeMember),
      "TSCallSignatureDeclaration:exit": this.nodeHandler(this.leaveSuppressedSubtree),
      TSConstructSignatureDeclaration: this.nodeHandler(this.enterOutlinedTypeMember),
      "TSConstructSignatureDeclaration:exit": this.nodeHandler(this.leaveSuppressedSubtree),
      TSPropertySignature: this.nodeHandler(this.enterTypeProperty),
      "TSPropertySignature:exit": this.nodeHandler(this.leaveSuppressedSubtree),
      TSTypeLiteral: this.nodeHandler(this.enterOmittedTypeMember),
      "TSTypeLiteral:exit": this.nodeHandler(this.leaveSuppressedSubtree),

      CallExpression: this.nodeHandler(this.enterCallExpression),
      NewExpression: this.nodeHandler(this.enterCallExpression),
    });
    /* oxlint-enable typescript/unbound-method */

    visitor.visit(program);
  }

  private nodeHandler(
    handler: (this: TypeScriptOutlineVisitor, node: AstNode) => void,
  ): (node: unknown) => void {
    return (node: unknown): void => {
      handler.call(this, astNode(node));
    };
  }

  private isSuppressed(): boolean {
    return this.suppressedSubtreeDepth > 0;
  }

  private appendOutlineEntry(text: string): OutlineEntry {
    const outlineEntry: OutlineEntry = { text, children: [] };
    const parentEntry = this.activeOutlineEntries.at(-1)?.entry;
    (parentEntry?.children ?? this.rootEntries).push(outlineEntry);
    return outlineEntry;
  }

  private appendSourceNode(node: AstNode): void {
    if (!this.isSuppressed()) {
      this.appendOutlineEntry(sourceNode(this.sourceText, node, this.literalRanges));
    }
  }

  private enterOutlineEntry(node: AstNode, text: string): void {
    if (this.isSuppressed()) {
      return;
    }

    const outlineEntry = this.appendOutlineEntry(text);
    this.activeOutlineEntries.push({ node, entry: outlineEntry });
    this.outlineEntryNodes.add(node);
  }

  private leaveOutlineEntry(node: AstNode): void {
    if (!this.outlineEntryNodes.has(node)) {
      return;
    }

    const activeEntry = this.activeOutlineEntries.pop();
    if (activeEntry?.node !== node) {
      throw new Error("TypeScript outline visitor entry stack became unbalanced");
    }
    this.outlineEntryNodes.delete(node);
  }

  private enterSuppressedSubtree(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    this.suppressedSubtreeRoots.add(node);
    this.suppressedSubtreeDepth += 1;
  }

  private leaveSuppressedSubtree(node: AstNode): void {
    if (!this.suppressedSubtreeRoots.has(node)) {
      return;
    }

    this.suppressedSubtreeRoots.delete(node);
    this.suppressedSubtreeDepth -= 1;
  }

  private declarationPrefix(node: AstNode): string {
    return this.declarationPrefixes.get(node) ?? "";
  }

  private enterExportDeclaration(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const declaration = astNodeProperty(node, "declaration");
    if (!declaration) {
      this.appendOutlineEntry(sourceNode(this.sourceText, node, this.literalRanges));
      return;
    }

    const prefix = sourceFragment(
      this.sourceText,
      node.start,
      declaration.start,
      this.literalRanges,
    );
    this.declarationPrefixes.set(declaration, `${prefix} `);
  }

  private enterTypeAliasDeclaration(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const identifier = astNodeProperty(node, "id");
    const typeParameters = astNodeProperty(node, "typeParameters");
    const headerEnd = typeParameters?.end ?? identifier?.end ?? node.end;
    this.appendOutlineEntry(
      `${this.declarationPrefix(node)}${sourceFragment(this.sourceText, node.start, headerEnd, this.literalRanges)}`,
    );
    this.enterSuppressedSubtree(node);
  }

  private enterDeclarationWithBody(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const body = astNodeProperty(node, "body");
    this.enterOutlineEntry(
      node,
      `${this.declarationPrefix(node)}${sourceFragment(
        this.sourceText,
        node.start,
        body?.start ?? node.end,
        this.literalRanges,
      )}`,
    );
  }

  private enterClass(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    this.enterDeclarationWithBody(node);
    this.classDepth += 1;
  }

  private leaveClass(node: AstNode): void {
    if (!this.outlineEntryNodes.has(node)) {
      return;
    }

    this.classDepth -= 1;
    this.leaveOutlineEntry(node);
  }

  private enterEnumDeclaration(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const body = astNodeProperty(node, "body");
    this.appendOutlineEntry(
      `${this.declarationPrefix(node)}${sourceFragment(
        this.sourceText,
        node.start,
        body?.start ?? node.end,
        this.literalRanges,
      )}`,
    );
    this.enterSuppressedSubtree(node);
  }

  private enterNamedFunction(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    this.enterFunctionOutline(node, {
      text: `${this.declarationPrefix(node)}${functionSignature(this.sourceText, node, this.literalRanges)}`,
      isAnonymous: false,
    });
  }

  private enterFunctionExpression(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    if (this.ignoredFunctionNodes.has(node)) {
      this.activeFunctions.set(node, { isAnonymous: false, hasOutlineEntry: false });
      this.functionDepth += 1;
      return;
    }

    this.enterFunctionOutline(
      node,
      this.functionPresentations.get(node) ?? {
        text: functionSignature(this.sourceText, node, this.literalRanges),
        isAnonymous: true,
      },
    );
  }

  private enterFunctionOutline(node: AstNode, presentation: FunctionOutlinePresentation): void {
    if (presentation.isAnonymous && this.anonymousFunctionDepth >= MAX_ANONYMOUS_FUNCTION_DEPTH) {
      this.enterSuppressedSubtree(node);
      return;
    }

    this.enterOutlineEntry(node, presentation.text);
    this.activeFunctions.set(node, {
      isAnonymous: presentation.isAnonymous,
      hasOutlineEntry: true,
    });
    this.functionDepth += 1;
    if (presentation.isAnonymous) {
      this.anonymousFunctionDepth += 1;
    }
  }

  private leaveFunction(node: AstNode): void {
    if (this.suppressedSubtreeRoots.has(node)) {
      this.leaveSuppressedSubtree(node);
      return;
    }

    const activeFunction = this.activeFunctions.get(node);
    if (!activeFunction) {
      return;
    }

    this.activeFunctions.delete(node);
    this.functionDepth -= 1;
    if (activeFunction.isAnonymous) {
      this.anonymousFunctionDepth -= 1;
    }
    if (activeFunction.hasOutlineEntry) {
      this.leaveOutlineEntry(node);
    }
  }

  private enterVariableDeclaration(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const declarationKind = typeof node["kind"] === "string" ? node["kind"] : "const";
    const includeConfiguredVariableName = this.functionDepth === 0 && this.classDepth === 0;

    for (const declarator of astNodeArrayProperty(node, "declarations")) {
      const identifier = astNodeProperty(declarator, "id");
      const initializer = astNodeProperty(declarator, "init");
      if (!initializer) {
        continue;
      }

      const identifierText = identifier
        ? sourceNode(this.sourceText, identifier, this.literalRanges)
        : "<anonymous>";
      const variablePrefix = `${this.declarationPrefix(node)}${declarationKind} ${identifierText} = `;

      if (
        initializer.type === "ArrowFunctionExpression" ||
        initializer.type === "FunctionExpression"
      ) {
        this.functionPresentations.set(initializer, {
          text: `${variablePrefix}${functionSignature(this.sourceText, initializer, this.literalRanges)}`,
          isAnonymous: false,
        });
        continue;
      }

      if (
        includeConfiguredVariableName &&
        (initializer.type === "CallExpression" || initializer.type === "NewExpression")
      ) {
        this.presentCallFunctions(initializer, variablePrefix);
      }
    }
  }

  private enterMethod(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const functionNode = astNodeProperty(node, "value") ?? node;
    const body = astNodeProperty(functionNode, "body");
    if (functionNode !== node) {
      this.ignoredFunctionNodes.add(functionNode);
    }
    this.enterOutlineEntry(
      node,
      sourceFragment(this.sourceText, node.start, body?.start ?? node.end, this.literalRanges),
    );
  }

  private enterFunctionProperty(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const value = astNodeProperty(node, "value");
    if (
      !value ||
      (value.type !== "ArrowFunctionExpression" && value.type !== "FunctionExpression")
    ) {
      return;
    }

    const body = astNodeProperty(value, "body");
    this.ignoredFunctionNodes.add(value);
    this.enterOutlineEntry(
      node,
      sourceFragment(this.sourceText, node.start, body?.start ?? node.end, this.literalRanges),
    );
  }

  private enterOutlinedTypeMember(node: AstNode): void {
    this.enterLeafTypeMember(node, true);
  }

  private enterOmittedTypeMember(node: AstNode): void {
    this.enterLeafTypeMember(node, false);
  }

  private enterLeafTypeMember(node: AstNode, includeInOutline: boolean): void {
    if (this.isSuppressed()) {
      return;
    }

    if (includeInOutline) {
      this.appendOutlineEntry(sourceNode(this.sourceText, node, this.literalRanges));
    }
    this.enterSuppressedSubtree(node);
  }

  private enterTypeProperty(node: AstNode): void {
    if (this.isSuppressed()) {
      return;
    }

    const propertyType = callablePropertyType(node);
    this.enterLeafTypeMember(node, propertyType?.type === "TSFunctionType");
  }

  private enterCallExpression(node: AstNode): void {
    if (!this.isSuppressed()) {
      this.presentCallFunctions(node);
    }
  }

  private presentCallFunctions(call: AstNode, firstFunctionPrefix = ""): void {
    const callArguments = astNodeArrayProperty(call, "arguments");
    let functionIndex = 0;

    for (const [argumentIndex, argument] of callArguments.entries()) {
      if (argument.type !== "ArrowFunctionExpression" && argument.type !== "FunctionExpression") {
        continue;
      }

      if (!this.functionPresentations.has(argument)) {
        const prefix = functionIndex === 0 ? firstFunctionPrefix : "";
        this.functionPresentations.set(argument, {
          text: `${prefix}${callWithAnonymousFunction(
            this.sourceText,
            call,
            argument,
            argumentIndex,
            callArguments,
            this.literalRanges,
          )}`,
          isAnonymous: true,
        });
      }
      functionIndex += 1;
    }
  }
}

/** Reads a TypeScript file and returns a TypeScript-native declaration outline without bodies. */
export async function readTypeScriptFileOutline(filePath: string): Promise<string> {
  const sourceText = await readFile(filePath, "utf8");
  const parsed = parseSync(filePath, sourceText, {
    astType: "ts",
    range: true,
    showSemanticErrors: true,
  });

  if (parsed.errors.length > 0) {
    throw new SyntaxError(
      `Cannot read TypeScript outline from ${filePath}:\n${parsed.errors
        .map((error) => error.codeframe ?? error.message)
        .join("\n")}`,
    );
  }

  const outlineVisitor = new TypeScriptOutlineVisitor(
    sourceText,
    collectLiteralRanges(parsed.program),
  );
  outlineVisitor.visit(parsed.program);
  return renderOutlineEntries(outlineVisitor.rootEntries).join("\n");
}
