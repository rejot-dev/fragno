// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ImagePreviewCard } from "./image-preview-card";

afterEach(cleanup);

test("keeps the source-file action available when an image fails and recovers on a new source", () => {
  const card = render(
    <p>
      <ImagePreviewCard
        src="/missing.png"
        alt="Dashboard preview"
        filename="dashboard.png"
        action={<a href="/files/dashboard.png">Open in Files</a>}
      />
    </p>,
  );
  fireEvent.error(card.getByRole("img", { name: "Dashboard preview" }));
  assert.include(card.getByRole("img").textContent, "Image unavailable");
  assert.equal(
    card.getByRole("link", { name: "Open in Files" }).getAttribute("href"),
    "/files/dashboard.png",
  );
  assert.equal(card.getByText("dashboard.png").getAttribute("title"), "dashboard.png");
  assert.equal(card.container.querySelector("p div, p figure"), null);

  card.rerender(
    <p>
      <ImagePreviewCard
        src="/updated.png"
        alt="Updated dashboard"
        filename="updated.png"
        action={<a href="/files/updated.png">Open in Files</a>}
      />
    </p>,
  );
  assert.equal(
    card.getByRole("img", { name: "Updated dashboard" }).getAttribute("src"),
    "/updated.png",
  );
  assert.equal(
    card.getByRole("link", { name: "Open in Files" }).getAttribute("href"),
    "/files/updated.png",
  );
  assert.equal(card.queryByText("dashboard.png"), null);
});
