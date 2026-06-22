import { describe, test, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "./bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "./bash-host.test-utils";

describe("createBashHost", () => {
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
