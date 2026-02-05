import { beforeAll, describe, expect, it } from "vitest";
import { Cursor, createCursorFromRecord, decodeCursor } from "./cursor-client";
import type { AnyColumn } from "../schema/create";

const ensureBase64Helpers = () => {
  const g = globalThis as typeof globalThis & {
    btoa?: (input: string) => string;
    atob?: (input: string) => string;
  };

  if (!g.btoa) {
    g.btoa = (input: string) => Buffer.from(input, "binary").toString("base64");
  }

  if (!g.atob) {
    g.atob = (input: string) => Buffer.from(input, "base64").toString("binary");
  }
};

beforeAll(() => {
  ensureBase64Helpers();
});

describe("cursor-client", () => {
  it("roundtrips cursor data with unicode values", () => {
    const cursor = new Cursor({
      indexName: "idx_created",
      orderDirection: "asc",
      pageSize: 25,
      indexValues: {
        createdAt: 1730000000000,
        name: "München",
      },
    });

    const encoded = cursor.encode();
    const decoded = decodeCursor(encoded);

    expect(decoded.indexName).toBe("idx_created");
    expect(decoded.orderDirection).toBe("asc");
    expect(decoded.pageSize).toBe(25);
    expect(decoded.indexValues).toEqual({
      createdAt: 1730000000000,
      name: "München",
    });
  });

  it("creates a cursor from a record", () => {
    const column: AnyColumn = {
      name: "createdAt",
      type: "timestamp",
      role: "regular",
      isNullable: false,
    } as AnyColumn;

    const cursor = createCursorFromRecord({ createdAt: 123, other: "ignore" }, [column], {
      indexName: "idx_created",
      orderDirection: "desc",
      pageSize: 10,
    });

    expect(cursor.indexValues).toEqual({ createdAt: 123 });
    expect(cursor.orderDirection).toBe("desc");
  });

  it("rejects malformed cursor payloads", () => {
    expect(() => decodeCursor("not-base64")).toThrowError(/Invalid cursor/);
  });
});
