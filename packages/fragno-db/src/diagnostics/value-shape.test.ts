import { describe, it, assert } from "vitest";

import { describeDiagnosticValue, truncateDiagnosticString } from "./value-shape";

describe("diagnostic value shapes", () => {
  it("describes configured discriminators without including value contents", () => {
    const value = {
      kind: "workflow-event",
      event: { type: "message_update", text: "secret" },
      payload: "hidden",
    };

    assert(
      describeDiagnosticValue(value, {
        keyLimit: 2,
        stringLimit: 160,
        discriminatorPaths: [["kind"], ["event", "type"]],
      }) === "object(keys=kind,event; kind=workflow-event, event.type=message_update)",
    );
  });

  it("truncates diagnostic strings at the configured boundary", () => {
    assert(truncateDiagnosticString("abcdefgh", 4) === "abcd…");
  });

  it("does not let an uninspectable object break failure diagnostics", () => {
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("uninspectable");
        },
      },
    );

    assert(
      describeDiagnosticValue(value, {
        keyLimit: 2,
        stringLimit: 10,
        discriminatorPaths: [],
      }) === "uninspectable-object",
    );
  });
});
