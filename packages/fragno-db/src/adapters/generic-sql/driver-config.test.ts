import { describe, expect, it } from "vitest";
import { MySQL2DriverConfig } from "./driver-config";

describe("MySQL2DriverConfig", () => {
  it("extracts affected rows from numAffectedRows", () => {
    const config = new MySQL2DriverConfig();
    expect(config.extractAffectedRows({ numAffectedRows: 2 })).toBe(2n);
  });

  it("extracts affected rows from numChangedRows", () => {
    const config = new MySQL2DriverConfig();
    expect(config.extractAffectedRows({ numChangedRows: 1 })).toBe(1n);
  });

  it("extracts affected rows from affectedRows", () => {
    const config = new MySQL2DriverConfig();
    expect(config.extractAffectedRows({ affectedRows: 3 })).toBe(3n);
  });

  it("extracts affected rows from changedRows", () => {
    const config = new MySQL2DriverConfig();
    expect(config.extractAffectedRows({ changedRows: 4 })).toBe(4n);
  });

  it("extracts affected rows from string values", () => {
    const config = new MySQL2DriverConfig();
    expect(config.extractAffectedRows({ numAffectedRows: "5" })).toBe(5n);
  });

  it("throws when no affected rows are present", () => {
    const config = new MySQL2DriverConfig();
    expect(() => config.extractAffectedRows({})).toThrow(
      "Driver mysql2 is expected to support affected rows.",
    );
  });
});
