import { describe, expect, it, assert } from "vitest";

import {
  formatDateForDisplay,
  formatDateForSave,
  formatDateTimeForSave,
  parseDate,
  parseDateTimeForPicker,
  parseOptionalString,
} from "./date-time";

describe("date picker values", () => {
  it("round-trips date-only values without timezone shifts", () => {
    const date = parseDate("2026-07-21");

    assert(date);
    assert(formatDateForDisplay(date) === "7/21/2026");
    assert(formatDateForSave(date) === "2026-07-21");
  });

  it.each(["2026-02-30", "07/21/2026", "not-a-date"])(
    "rejects invalid date-only value %s",
    (value) => {
      assert(parseDate(value) === undefined);
    },
  );
});

describe("date-time picker values", () => {
  it("uses one UTC calendar and time representation", () => {
    const pickerValue = parseDateTimeForPicker("2026-07-22T01:30:00.000Z");

    assert(pickerValue.date);
    assert(formatDateForDisplay(pickerValue.date) === "7/22/2026");
    assert(pickerValue.time === "01:30");
    assert(
      formatDateTimeForSave(pickerValue.date, pickerValue.time) === "2026-07-22T01:30:00.000Z",
    );
  });
});

describe("parseOptionalString", () => {
  it("accepts strings and undefined", () => {
    assert(parseOptionalString("2026-07-21", "Date data") === "2026-07-21");
    expect(parseOptionalString(undefined, "Date data")).toBeUndefined();
  });

  it.each([null, 0, {}, []])("rejects non-string data %#", (value) => {
    expect(() => parseOptionalString(value, "Date data")).toThrow(TypeError);
  });
});
