import { expect, test } from "vitest";

import { serverOnly$, clientOnly$ } from "./macros";

test("unreplaced macro throws error", () => {
  expect(() => serverOnly$("hello")).toThrow(/unreplaced macro/);
  expect(() => clientOnly$("world")).toThrow(/unreplaced macro/);
});
