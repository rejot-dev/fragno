import { describe, it, assert } from "vitest";

import { MySQL2DriverConfig } from "../../../adapters/generic-sql/driver-config";
import type { AnyColumn } from "../../../schema/create";
import { MySQLSerializer } from "./mysql-serializer";

const withTimezone = (timezone: string, run: () => void) => {
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
};

describe("MySQLSerializer", () => {
  const serializer = new MySQLSerializer(new MySQL2DriverConfig());
  const dateColumn: AnyColumn = {
    name: "happenedOn",
    type: "date",
    role: "regular",
    isNullable: false,
  } as AnyColumn;

  describe("deserializeDate", () => {
    it("normalizes Date-backed date columns using UTC calendar fields", () => {
      withTimezone("America/Los_Angeles", () => {
        const mysqlDate = new Date("2024-03-10T00:00:00.000Z");

        const date = serializer["deserializeDate"](mysqlDate, dateColumn);

        assert(date.toISOString() === "2024-03-10T00:00:00.000Z");
      });
    });
  });
});
