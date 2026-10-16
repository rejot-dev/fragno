import { useEffect, useState } from "react";
import { render } from "react-email";

import {
  EmailButton,
  EmailFootnote,
  EmailParagraph,
  TransactionalEmail,
} from "./transactional-email";

export default { title: "Brand/Transactional email" };

// An email is a whole HTML document, so it renders to markup inside an iframe rather than into the
// story's own document.
export function Invitation() {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void render(
      <TransactionalEmail
        preview="Create your Backoffice account to get started."
        heading="You're invited"
        homeUrl="https://backoffice.example"
        reason="You received this email because someone invited you to Backoffice. If you were not expecting it, you can ignore it."
      >
        <EmailParagraph>Create your Backoffice account to get started.</EmailParagraph>
        <EmailButton href="https://backoffice.example/sign-up">Create account</EmailButton>
        <EmailFootnote href="https://backoffice.example/sign-up">
          This invitation expires in 7 days and only works for new-user@example.com.
        </EmailFootnote>
      </TransactionalEmail>,
    ).then((rendered) => {
      if (current) {
        setHtml(rendered);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  return html === null ? (
    <p className="text-sm text-[var(--bo-muted)]">Rendering…</p>
  ) : (
    <iframe
      title="Invitation email"
      srcDoc={html}
      className="h-[640px] w-full max-w-2xl border-0"
    />
  );
}
