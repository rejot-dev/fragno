import { assert, describe, it } from "vitest";

import { createUiSchemaElementKeys } from "./ui-schema-keys";

const repeatedControl = { type: "Control", scope: "#/properties/name" } as const;

describe("createUiSchemaElementKeys", () => {
  it("assigns stable, unique keys to repeated elements", () => {
    const keys = createUiSchemaElementKeys([repeatedControl, repeatedControl]);

    const serializedControl = JSON.stringify(repeatedControl);
    assert(new Set(keys).size === 2);
    assert(keys[0]?.includes(serializedControl));
    assert(keys[1]?.includes(serializedControl));
  });
});
