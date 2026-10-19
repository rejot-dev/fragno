import { Link } from "react-router";

export function meta() {
  return [{ title: "Help signing in · Bookkeeping" }];
}

export default function Help() {
  return (
    <section className="auth">
      <h1>Help signing in</h1>
      <p>
        To sign in, enter your email address. We send a 6-digit code to it, which you type on the
        next page. The first time, this creates your account.
      </p>
      <h2>The email doesn't arrive</h2>
      <p>
        It can take a minute. Check your spam or promotions folder, and make sure you typed the
        address correctly. After a minute you can ask for a new code; use the most recent email.
      </p>
      <h2>The code doesn't work</h2>
      <p>
        A code works once, for 10 minutes. If it has expired or you mistyped it a few times, ask for
        a new one.
      </p>
      <h2>The page says it has expired</h2>
      <p>
        Sign-in pages last 10 minutes. Go back and start again from{" "}
        <Link to="/login">Get started</Link>.
      </p>
    </section>
  );
}
