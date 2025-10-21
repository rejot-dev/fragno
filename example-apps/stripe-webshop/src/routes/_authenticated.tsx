import { createFileRoute, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { useSession } from "@/lib/auth/client";
import { useEffect } from "react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
});

function AuthLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isPending && !session?.user) {
      navigate({
        to: "/login",
        search: {
          redirect: location.href,
        },
      });
    }
  }, [session, isPending, navigate, location.href]);

  if (isPending || !session?.user) {
    return null;
  }

  return <Outlet />;
}
