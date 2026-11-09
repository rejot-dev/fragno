import type { Root, RootContent } from "hast";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

/** What linking reads of the books: the codes of their records, and the IDs pages address. */
type LinkedBooks = {
  accounts: readonly { id: string; code: string }[];
  journals: readonly { code: string }[];
  parties: readonly { accounts: readonly { id: string; role: string; code: string }[] }[];
};

const LINK = /^(accounts|entries|customers|suppliers|documents)\/([^/?#]+)(?:\/([^/?#]+))?$/u;

/**
 * The page of the books a link the agent wrote leads to, under `base`; null when it names nothing
 * these books have, or is no link to the books. `BOOKS_AGENT`'s instructions teach these links.
 */
export function booksLinkPath(href: string, books: LinkedBooks, base: string): string | null {
  const match = LINK.exec(href);
  if (match === null) {
    return null;
  }
  const [, kind, first, second] = match;
  let code: string;
  try {
    code = decodeURIComponent(first);
  } catch {
    return null;
  }
  switch (kind) {
    case "accounts": {
      const account = books.accounts.find((row) => row.code === code);
      return second === undefined && account ? `${base}/accounts/${account.id}` : null;
    }
    case "entries": {
      const journal = books.journals.find((row) => row.code === code);
      const number = Number(second);
      return journal && Number.isSafeInteger(number) && number > 0
        ? `${base}/entries/${encodeURIComponent(journal.code)}/${number}`
        : null;
    }
    case "customers":
    case "suppliers": {
      const role = kind === "customers" ? "customer" : "supplier";
      const account = books.parties
        .flatMap((party) => party.accounts)
        .find((row) => row.role === role && row.code === code);
      return second === undefined && account ? `${base}/parties/${account.id}` : null;
    }
    case "documents":
      return second === undefined && /^[0-9a-f-]{36}$/u.test(code)
        ? `${base}/documents/${code}`
        : null;
  }
  return null;
}

const SCHEME = /^[a-z][a-z\d+.-]*:|^\/\//iu;

/**
 * A rehype plugin turning the agent's links to the books into `books-link` elements with the
 * page's path, which the chat renders as links within Bookkeeping. A relative link to nothing these
 * books have reads as its text, where hardening would mark it blocked.
 */
function rehypeBooksLinks(options: { books: LinkedBooks; base: string }) {
  const visit = (node: Root | RootContent) => {
    if (node.type === "element" && node.tagName === "a") {
      const { href } = node.properties;
      if (typeof href === "string" && !SCHEME.test(href)) {
        const path = booksLinkPath(href, options.books, options.base);
        node.tagName = path === null ? "span" : "books-link";
        node.properties = path === null ? {} : { to: path };
      }
    }
    if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  return (tree: Root) => {
    visit(tree);
  };
}

/**
 * Streamdown's rehype plugins with the books' links resolved: after sanitizing, so a raw tag cannot
 * pose as one, and before hardening, which blocks relative links.
 */
export function booksRehypePlugins(
  books: LinkedBooks,
  base: string,
): StreamdownProps["rehypePlugins"] {
  return [
    defaultRehypePlugins.raw,
    defaultRehypePlugins.sanitize,
    [rehypeBooksLinks, { books, base }],
    defaultRehypePlugins.harden,
  ];
}
