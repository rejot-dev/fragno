import { ButtonLink } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { useOutletContext } from "react-router";

import type { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Bookkeeping · A clearer place for your books" }];
}

export default function Home() {
  const { user } = useOutletContext<{ user: typeof authClient.$Infer.Session.user | null }>();
  return (
    <div className="frontpage">
      <section className="frontpage-hero">
        <div>
          <h1>Make room for clearer books.</h1>
          <p className="hero-description">
            A quiet workspace for the financial side of your work. Start with an account; your books
            will have a place to grow.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink variant="solid" to={user ? "/dashboard" : "/signup"}>
              {user ? "Open your dashboard" : "Create your workspace"}
            </ButtonLink>
            {!user && (
              <ButtonLink variant="ghost" to="/login">
                Already have an account?
              </ButtonLink>
            )}
          </div>
          <p className="hero-note">Sign in with Backoffice or use your email and password.</p>
        </div>
        <div className="workspace-preview">
          <div className="flex items-center justify-between border-b border-[var(--bo-border)] pb-4">
            <span className="flex items-center gap-3 text-sm font-semibold">
              <Icon name="book-open" className="size-5 text-[var(--bo-accent)]" />
              Bookkeeping
            </span>
            <span className="text-xs text-[var(--bo-muted)]">A clean start</span>
          </div>
          <div className="preview-book" aria-hidden="true">
            <Icon name="book-open" className="size-16" strokeWidth={1.25} />
          </div>
          <h2 className="text-xl font-semibold">One workspace. Less noise.</h2>
          <p className="mt-3 text-sm leading-relaxed text-[var(--bo-muted)]">
            Your account is the first step. Bookkeeping tools are on the way.
          </p>
          <div className="mt-6 flex items-center gap-2 border-t border-[var(--bo-border)] pt-4 text-xs text-[var(--bo-muted)]">
            <Icon name="lock" className="size-4" />
            Your workspace starts with a secure sign-in.
          </div>
        </div>
      </section>
      <section className="frontpage-details" aria-label="Getting started">
        <div>
          <Icon name="user-check" className="mb-4 size-5 text-[var(--bo-accent)]" />
          <h2 className="text-base font-semibold">Your own workspace</h2>
          <p>Create an account and get a dedicated place to begin.</p>
        </div>
        <div>
          <Icon name="log-in" className="mb-4 size-5 text-[var(--bo-accent)]" />
          <h2 className="text-base font-semibold">Use your Backoffice account</h2>
          <p>Continue with the account you already use, or sign up with email.</p>
        </div>
        <div>
          <Icon name="book" className="mb-4 size-5 text-[var(--bo-accent)]" />
          <h2 className="text-base font-semibold">Built from a clean slate</h2>
          <p>This is an early workspace. Transactions and reports are coming later.</p>
        </div>
      </section>
    </div>
  );
}
