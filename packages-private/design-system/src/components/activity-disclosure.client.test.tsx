// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ActivityDisclosure } from "./activity-disclosure";

afterEach(cleanup);

function renderEntry(autoOpen: boolean) {
  return (
    <ActivityDisclosure marker="progress" title="execCodeMode" time={null} autoOpen={autoOpen}>
      <p>Result body</p>
    </ActivityDisclosure>
  );
}

test("an entry follows autoOpen when it changes and keeps the reader's toggle in between", () => {
  const entry = render(renderEntry(false));
  const details = entry.container.querySelector("details");
  assert(details);
  assert.isFalse(details.open);

  entry.rerender(renderEntry(true));
  assert.isTrue(details.open);

  // The reader closes it.
  details.open = false;
  fireEvent(details, new Event("toggle"));
  entry.rerender(renderEntry(true));
  assert.isFalse(details.open);

  entry.rerender(renderEntry(false));
  entry.rerender(renderEntry(true));
  assert.isTrue(details.open);
});
