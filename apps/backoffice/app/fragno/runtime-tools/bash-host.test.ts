import { assert, describe, expect, test } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "./bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "./bash-host.test-utils";

describe("createBashHost", () => {
  test("exposes the exact current execution scope", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        execution: {
          ...EMPTY_BASH_HOST_CONTEXT.execution,
          scope: { kind: "org", orgId: "org-1" },
        },
      },
    });

    await expect(bash.exec("context.current")).resolves.toMatchObject({
      stdout: "kind   org\norgId  org-1\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(bash.exec("context.current --format json")).resolves.toMatchObject({
      stdout: '{"kind":"org","orgId":"org-1"}\n',
      stderr: "",
      exitCode: 0,
    });
    await expect(bash.exec("context.current --print org-id")).resolves.toMatchObject({
      stdout: "org-1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test.skip("regression: defense-in-depth handles assignment command substitutions", async () => {
    const { bash } = createBashHost({
      fs: new InMemoryFs(),
      context: EMPTY_BASH_HOST_CONTEXT,
    });

    const result = await bash.exec('value="$(echo ok)"; echo "$value"');

    assert(result.stderr === "");
    assert(result.exitCode === 0);
    assert(result.stdout === "ok\n");
  });
});
