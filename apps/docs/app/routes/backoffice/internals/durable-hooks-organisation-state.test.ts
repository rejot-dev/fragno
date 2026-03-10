import { describe, expect, it, vi } from "vitest";
import {
  getDurableHooksLoaderErrorMessage,
  type DurableHooksOrgFragment,
} from "./durable-hooks-organisation-state";

describe("getDurableHooksLoaderErrorMessage", () => {
  it("returns a fixed upload error while logging the underlying failure", () => {
    const logError = vi.fn();
    const error = new Error("Missing storage credentials");

    const message = getDurableHooksLoaderErrorMessage({
      fragment: "upload",
      orgId: "org_123",
      error,
      logError,
    });

    expect(message).toBe("Upload service unavailable");
    expect(logError).toHaveBeenCalledWith("Failed to load Upload durable hooks", {
      fragment: "upload",
      orgId: "org_123",
      error,
    });
  });

  it.each([
    ["telegram", "Failed to load Telegram durable hooks."],
    ["resend", "Failed to load Resend durable hooks."],
    ["github", "Failed to load GitHub durable hooks."],
  ] satisfies readonly [DurableHooksOrgFragment, string][])(
    "returns a generic fragment error for %s",
    (fragment, expectedMessage) => {
      const logError = vi.fn();
      const error = new Error("internal details");

      const message = getDurableHooksLoaderErrorMessage({
        fragment,
        orgId: "org_123",
        error,
        logError,
      });

      expect(message).toBe(expectedMessage);
      expect(logError).toHaveBeenCalledOnce();
    },
  );
});
