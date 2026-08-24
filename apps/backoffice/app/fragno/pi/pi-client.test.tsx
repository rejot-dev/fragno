// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { cleanup, renderHook } from "@testing-library/react";

import { usePiClient } from "./pi-client";

afterEach(cleanup);

test("keeps the Pi client stable across equivalent scope objects", () => {
  const { result, rerender } = renderHook(
    ({ orgId }: { orgId: string }) => usePiClient({ kind: "org", orgId }),
    { initialProps: { orgId: "org-1" } },
  );
  const initialClient = result.current;

  rerender({ orgId: "org-1" });
  assert(result.current === initialClient);

  rerender({ orgId: "org-2" });
  assert(result.current !== initialClient);
});
