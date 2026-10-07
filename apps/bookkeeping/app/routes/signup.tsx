import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";
import { useState } from "react";
import { Link } from "react-router";

import { BackofficeLogin } from "../components/backoffice-login";
import { authClient } from "../lib/auth-client";

export function meta() {
  return [{ title: "Sign up · Bookkeeping" }];
}

export default function Signup() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <section className="auth">
      <h1>Create your account</h1>
      <p>Get started with Backoffice or create an email account.</p>
      <BackofficeLogin />
      <FormContainer title="Sign up with email">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            setPending(true);
            setError(null);
            try {
              const result = await authClient.signUp.email({
                name: String(fields.get("name")),
                email: String(fields.get("email")),
                password: String(fields.get("password")),
              });
              if (result.error) {
                setError(result.error.message ?? "Could not create your account.");
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
          <FormField label="Name">
            <Input
              className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
              name="name"
              autoComplete="name"
              required
            />
          </FormField>
          <FormField label="Email">
            <Input
              className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </FormField>
          <FormField label="Password" hint="Use 8–128 characters.">
            <Input
              className="w-full focus-visible:ring-2 focus-visible:ring-[var(--bo-accent)]/30"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </FormField>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" variant="accent" disabled={pending}>
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </FormContainer>
      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </section>
  );
}
