import { describe, expect, it } from "vitest";

import { renderOutput } from "./index";

describe("renderOutput", () => {
  it("renders table output", () => {
    const output = renderOutput(
      {
        format: "table",
        columns: [
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
        ],
        rows: [
          { id: "session-1", status: "running" },
          { id: "session-2", status: "done" },
        ],
      },
      false,
    );

    expect(output).toMatchInlineSnapshot(`
      "ID         Status 
      ---------  -------
      session-1  running
      session-2  done   "
    `);
  });

  it("renders pretty json output", () => {
    const output = renderOutput({ format: "pretty-json", data: { ok: true } }, false);

    expect(output).toMatchInlineSnapshot(`
      "{
        "ok": true
      }"
    `);
  });

  it("renders raw json output", () => {
    const output = renderOutput({ format: "json", data: { id: 1 } }, false);

    expect(output).toBe('{"id":1}');
  });

  it("passes through text output", () => {
    const output = renderOutput({ format: "text", text: "Hello" }, false);

    expect(output).toBe("Hello");
  });

  it("forces json output when --json is set", () => {
    const output = renderOutput({ format: "pretty-json", data: { id: "session-1" } }, true);

    expect(output).toBe('{"id":"session-1"}');
  });
});
