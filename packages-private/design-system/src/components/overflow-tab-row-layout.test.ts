import { assert, describe, test } from "vitest";

import { visibleOverflowTabCount } from "./overflow-tab-row-layout";

const tabs = [
  { width: 100, startsGroup: false },
  { width: 100, startsGroup: true },
  { width: 100, startsGroup: false },
] as const;

const measurement = {
  tabs,
  moreTriggerWidth: 70,
  separatorWidth: 1,
  gapWidth: 8,
};

describe("overflow tab row layout", () => {
  test("keeps every tab visible when the complete row fits", () => {
    assert.equal(visibleOverflowTabCount({ ...measurement, availableWidth: 400 }), 3);
  });

  test("reserves room for the overflow trigger", () => {
    assert.equal(visibleOverflowTabCount({ ...measurement, availableWidth: 290 }), 1);
  });

  test("moves every tab into the menu when only the trigger fits", () => {
    assert.equal(visibleOverflowTabCount({ ...measurement, availableWidth: 80 }), 0);
  });
});
