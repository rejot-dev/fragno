import { expect, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";

import { BackofficeJsonForm } from "./backoffice-json-form";

test("defers JSON Forms schema compilation during server rendering", () => {
  const markup = renderToStaticMarkup(
    <BackofficeJsonForm
      schema={{
        type: "object",
        properties: { name: { type: "string", title: "Name" } },
      }}
    />,
  );

  expect(markup).toContain('aria-label="Loading form preview"');
  expect(markup).not.toContain("Name");
});
