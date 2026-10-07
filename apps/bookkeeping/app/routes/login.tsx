import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useState } from "react";
import { Link } from "react-router";

import { BackofficeLogin } from "../components/backoffice-login";
import { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Log in · Bookkeeping" }];
}

export default function Login() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <section className="auth">
      <h1>Welcome back</h1>
      <p>Log in to your Bookkeeping account.</p>
      <BackofficeLogin />
      <FormContainer title="Log in with email">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            setPending(true);
            setError(null);
            try {
              const result = await authClient.signIn.email({
                email: String(fields.get("email")),
                password: String(fields.get("password")),
              });
              if (result.error) {
                setError(result.error.message ?? "Could not log in.");
              } else {
                window.location.assign("/dashboard");
              }
            } catch {
              setError("Could not connect. Please try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <FormField label="Email">
            <Input
              className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </FormField>
          <FormField label="Password">
            <Input
              className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </FormField>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" variant="accent" disabled={pending}>
            {pending ? "Logging in…" : "Log in"}
          </Button>
        </form>
      </FormContainer>
      <p>
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </section>
  );
}
