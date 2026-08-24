import { afterEach, expect, test } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTypeScriptFileOutline } from "./read-typescript-file-outline.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("returns a TypeScript-native declaration tree without local variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typescript-outline-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "example.ts");

  await writeFile(
    filePath,
    [
      'import type { User, UserId } from "./user.js";',
      'import { decode as parse } from "./codec.js";',
      "",
      "export type UserResult<T> = { value: T };",
      "",
      "export interface UserRepository {",
      "  find(id: UserId): Promise<User>;",
      "  name: string;",
      "  transform: (user: User) => User;",
      "}",
      "",
      "export class UserService implements UserRepository {",
      "  constructor(private database: Database) {}",
      "",
      "  async find(id: UserId): Promise<User> {",
      "    const result = rows.map((row: UserRow): User => parse(row));",
      "    return result[0];",
      "  }",
      "}",
      "",
      "export const handleRequest = async (request: Request): Promise<Response> => {",
      "  const timeout = 1000;",
      "  function normalize(value: string): string {",
      "    return value.trim();",
      "  }",
      "  return load(request).catch(function (error: unknown): Response {",
      "    return new Response(normalize(String(error)));",
      "  });",
      "};",
    ].join("\n"),
  );

  await expect(readTypeScriptFileOutline(filePath)).resolves.toBe(
    [
      'import type { User, UserId } from "./user.js"',
      'import { decode as parse } from "./codec.js"',
      "export type UserResult<T>",
      "export interface UserRepository",
      "  find(id: UserId): Promise<User>",
      "  transform: (user: User) => User",
      "export class UserService implements UserRepository",
      "  constructor(private database: Database)",
      "  async find(id: UserId): Promise<User>",
      "    rows.map((row: UserRow): User =>)",
      "export const handleRequest = async (request: Request): Promise<Response> =>",
      "  function normalize(value: string): string",
      "  load(request).catch(function (error: unknown): Response)",
    ].join("\n"),
  );
});

test("keeps fluent configuration callbacks compact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typescript-outline-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "schema.ts");

  await writeFile(
    filePath,
    [
      'import { column, schema } from "db";',
      "",
      'export const appSchema = schema("app", (s) => {',
      "  return s",
      '    .addTable("users", (t) => {',
      "      return t.addColumn(",
      '        "createdAt",',
      '        column("timestamp").defaultTo((builder) => builder.now()),',
      "      );",
      "    })",
      '    .addTable("projects", (t) => {',
      '      return t.addColumn("name", column("string"));',
      "    })",
      '    .alterTable("users", (t) => t);',
      "});",
    ].join("\n"),
  );

  await expect(readTypeScriptFileOutline(filePath)).resolves.toBe(
    [
      'import { column, schema } from "db"',
      'export const appSchema = schema("app", (s) =>)',
      '  s.addTable("users", (t) =>)',
      '  s.addTable("projects", (t) =>)',
      '  s.alterTable("users", (t) =>)',
    ].join("\n"),
  );
});

test("preserves string and regular-expression literal text while compacting trivia", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typescript-outline-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "literals.ts");

  await writeFile(
    filePath,
    [
      'import value from "./a . b";',
      "export const configure = setup(",
      '  "keep  spaces . here",',
      "  /keep  spaces . here/gi,",
      "  () => {",
      "    return value;",
      "  },",
      ");",
    ].join("\n"),
  );

  await expect(readTypeScriptFileOutline(filePath)).resolves.toBe(
    [
      'import value from "./a . b"',
      'export const configure = setup("keep  spaces . here", /keep  spaces . here/gi, () =>)',
    ].join("\n"),
  );
});

test("renders preceding callback arguments without their bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typescript-outline-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "callbacks.ts");

  await writeFile(
    filePath,
    [
      "export const configured = configure(",
      "  () => {",
      "    firstImplementation();",
      "  },",
      "  () => {",
      "    secondImplementation();",
      "  },",
      ");",
    ].join("\n"),
  );

  await expect(readTypeScriptFileOutline(filePath)).resolves.toBe(
    ["export const configured = configure(() =>, …)", "configure(() =>, () =>)"].join("\n"),
  );
});

test("rejects files with syntax errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typescript-outline-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "invalid.ts");

  await writeFile(filePath, "const value = ;");

  await expect(readTypeScriptFileOutline(filePath)).rejects.toThrow(
    `Cannot read TypeScript outline from ${filePath}`,
  );
});
