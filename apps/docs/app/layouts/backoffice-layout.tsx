import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { BackofficeShell } from "@/components/backoffice";
import "../backoffice.css";

export function loader() {
  if (import.meta.env.MODE !== "development") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
}

export default function BackofficeLayout({ children }: { children?: ReactNode }) {
  return <BackofficeShell>{children ?? <Outlet />}</BackofficeShell>;
}
