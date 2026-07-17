import { describe, it, assert, expect } from "vitest";

import { MySQL2DriverConfig } from "../../../adapters/generic-sql/driver-config";
import type { AnyColumn } from "../../../schema/create";
import { MySQLSerializer } from "./mysql-serializer";

function withTimezone(timezone: string, run: () => void): void {
  const previousTimezone = process.env["TZ"];
  try {
    process.env["TZ"] = timezone;
    run();
  } finally {
    if (previousTimezone === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = previousTimezone;
    }
  }
}

describe("MySQLSerializer", () => {
  const serializer = new MySQLSerializer(new MySQL2DriverConfig());
  const dateColumn: AnyColumn = {
    name: "happenedOn",
    type: "date",
    role: "regular",
    isNullable: false,
  } as AnyColumn;

  describe("deserializeDate", () => {
    it("parses date-only strings as UTC calendar dates in a non-UTC runtime", () => {
      withTimezone("America/Los_Angeles", () => {
        const date = serializer["deserializeDate"]("2024-03-10", dateColumn);

        assert(date.toISOString() === "2024-03-10T00:00:00.000Z");
      });
    });

    it("rejects Date-backed DATE values before timezone conversion can change the day", () => {
      expect(() =>
        serializer["deserializeDate"](new Date("2024-03-10T00:00:00.000Z"), dateColumn),
      ).toThrow("MySQL DATE columns must be projected as strings before result deserialization.");
    });

    it.each(["2024-02-30", "2024-3-10", "not-a-date"])(
      "rejects invalid date-only value %s",
      (value) => {
        expect(() => serializer["deserializeDate"](value, dateColumn)).toThrow(
          `Cannot deserialize MySQL DATE from value: ${value}`,
        );
      },
    );
  });
});
