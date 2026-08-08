import { redirect } from "react-router";

export function loader() {
  return redirect("/backoffice");
}

export default function Index() {
  return null;
}
