import { expect, test } from "vitest";

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";

import { booksRehypePlugins } from "./books-links";

const BOOKS = {
  accounts: [{ id: "account-bank", code: "1000" }],
  journals: [{ code: "SAL" }],
  parties: [{ accounts: [{ id: "party-acme", role: "customer", code: "C001" }] }],
};
const BASE = "/w/acme/a/books-1";

/** The chat's Markdown, with each link to the books as `<books-link to=…>` and others as they are. */
function render(markdown: string) {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        skipHtml: true,
        rehypePlugins: booksRehypePlugins(BOOKS, BASE),
        components: {
          // As the chat's, which receives what rehypeBooksLinks resolved.
          "books-link": (({ to, children }: { to: string; children: ReactNode }) =>
            createElement("books-link", { to }, children)) as ComponentType,
        },
      },
      markdown,
    ),
  );
}

test("the agent's links to the books lead to their pages, by the IDs pages address", () => {
  const html = render(
    "[1000 Bank](accounts/1000), [SAL 3](entries/SAL/3), [Acme](customers/C001), and [invoice.pdf](documents/0b5c6d8e-6f4a-4c2b-9a51-3f6e2d1c0a9b).",
  );
  expect(html).toContain(`<books-link to="${BASE}/accounts/account-bank">1000 Bank</books-link>`);
  expect(html).toContain(`<books-link to="${BASE}/entries/SAL/3">SAL 3</books-link>`);
  expect(html).toContain(`<books-link to="${BASE}/parties/party-acme">Acme</books-link>`);
  expect(html).toContain(
    `<books-link to="${BASE}/documents/0b5c6d8e-6f4a-4c2b-9a51-3f6e2d1c0a9b">invoice.pdf</books-link>`,
  );
});

test("a link to nothing these books have reads as its text, and other links stay links", () => {
  const html = render(
    "[2000 Loans](accounts/2000), [Acme](suppliers/C001), [home](/logout), and [docs](https://example.com/help).",
  );
  expect(html).not.toContain("books-link");
  expect(html).not.toContain("[blocked]");
  expect(html).toContain("2000 Loans");
  // Streamdown asks before leaving for another site.
  expect(html).toMatch(/data-streamdown="link"[^>]*>docs</u);
  expect(html).not.toContain("/logout");
});
