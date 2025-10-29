import { createFileRoute, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useSession } from "@/lib/auth/client";
import { useEffect } from "react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
});

function AuthLayout() {
  const { data: session, isPending } = useSession();
  // TODO: add current subscription to this session: https://www.better-auth.com/docs/concepts/session-management#customizing-session-response
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isPending && !session?.user && location.pathname !== "/login") {
      navigate({
        to: "/login",
        search: {
          redirect: location.pathname,
        },
      });
    }
  }, [session, isPending, navigate, location.pathname]);

  if (isPending || !session?.user) {
    return null;
  }

  return <Outlet />;
}
