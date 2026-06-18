import { describe, test, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost, EMPTY_BASH_HOST_CONTEXT } from "./bash-host";

describe("createBashHost", () => {
  test("regression: defense-in-depth handles assignment command substitutions", async () => {
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
