import { Link } from "react-router";

import { SignInButton } from "../components/sign-in-button";

export function meta() {
  return [{ title: "Get started · Bookkeeping" }];
}

export default function Login() {
  return (
    <section className="auth">
      <h1>Get started</h1>
      <p>
        Sign in or create your account. We'll email you a code, so there's no password to remember.
      </p>
      <SignInButton />
      <p>
        Trouble signing in? <Link to="/help">Get help</Link>
      </p>
    </section>
  );
}
