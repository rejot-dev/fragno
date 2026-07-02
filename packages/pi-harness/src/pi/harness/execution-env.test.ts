import { assert, describe, expect, it } from "vitest";

import { NoOpExecutionEnv } from "./execution-env";

describe("NoOpExecutionEnv", () => {
  it("resolves paths relative to cwd", async () => {
    const env = new NoOpExecutionEnv({ cwd: "/workspace/project" });

    await expect(env.absolutePath("../notes/./todo.md")).resolves.toMatchObject({
      ok: true,
      value: "/workspace/notes/todo.md",
    });
    await expect(env.joinPath(["src", "../README.md"])).resolves.toMatchObject({
      ok: true,
      value: "/workspace/project/README.md",
    });
  });

  it("returns typed errors for filesystem and shell operations", async () => {
    const env = new NoOpExecutionEnv({ cwd: "/workspace/project" });

    const readResult = await env.readTextFile("README.md");
    assert(!readResult.ok);
    assert(readResult.error.code === "not_supported");

    const writeResult = await env.writeFile("docs/plan.md", "hello");
    assert(!writeResult.ok);
    assert(writeResult.error.code === "not_supported");

    const tempResult = await env.createTempFile();
    assert(!tempResult.ok);
    assert(tempResult.error.code === "not_supported");

    const execResult = await env.exec("echo nope");
    assert(!execResult.ok);
    assert(execResult.error.code === "shell_unavailable");
  });
});
