// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ImagePreview } from "./image-preview";

afterEach(cleanup);

test("a failed preview explains the missing image and recovers when the source changes", () => {
  const preview = render(<ImagePreview src="/missing.png" alt="Dashboard preview" />);
  const image = preview.getByRole("img", { name: "Dashboard preview" });
  fireEvent.error(image);
  assert.equal(preview.container.querySelector("img"), null);
  assert.include(
    preview.getByRole("img", { name: "Dashboard preview" }).textContent,
    "Image unavailable",
  );

  preview.rerender(<ImagePreview src="/available.png" alt="Updated dashboard" />);
  assert.equal(
    preview.getByRole("img", { name: "Updated dashboard" }).getAttribute("src"),
    "/available.png",
  );
  assert.equal(preview.queryByText(/Image unavailable/), null);

  preview.rerender(<ImagePreview src={null} alt="Private image" />);
  assert.equal(preview.container.querySelector("img"), null);
  assert.include(
    preview.getByRole("img", { name: "Private image" }).textContent,
    "Image unavailable",
  );
});
