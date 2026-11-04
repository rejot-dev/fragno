// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { createRoutesStub, Link, Outlet, useParams } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BooksOutletContext } from "../books/layout";
import AskPage from "./ask";

afterEach(cleanup);

/** The books' layout, as far as the Ask page reads it, with links to two administrations. */
function BooksLayout() {
  const { administration } = useParams();
  const base = `/w/client/a/${administration}`;
  // The Ask page reads only the books' name and path.
  const context = { books: { name: administration }, base } as unknown as BooksOutletContext;
  return (
    <>
      <Link to="/w/client/a/first/ask">First</Link>
      <Link to="/w/client/a/second/ask">Second</Link>
      <Outlet context={context} />
    </>
  );
}

test("switching administrations starts their conversation afresh", async () => {
  const Stub = createRoutesStub([
    {
      path: "/w/client/a/:administration",
      Component: BooksLayout,
      children: [
        {
          path: "ask",
          Component: AskPage,
          loader: () => ({ agent: { ok: true, provisioned: false } }),
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/w/client/a/first/ask"]} />);
  const question = await screen.findByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(question, { target: { value: "What do customers owe the first books?" } });

  fireEvent.click(screen.getByRole("link", { name: "Second" }));
  await screen.findByText("second");
  assert.equal(screen.getByRole<HTMLTextAreaElement>("textbox").value, "");
});
