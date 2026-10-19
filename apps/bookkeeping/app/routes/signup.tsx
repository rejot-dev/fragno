import { redirect } from "react-router";

// Signing in creates the account for a new address, so signing up has no page of its own.
export function loader() {
  throw redirect("/login");
}
