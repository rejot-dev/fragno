import { LoginForm } from "@/components/login-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSession } from "@/lib/auth/client";
import { useEffect } from "react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) => {
    return {
      redirect: typeof search["redirect"] === "string" ? search["redirect"] : undefined,
    };
  },
});

function LoginPage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    // If already authenticated, redirect to profile
    if (!isPending && session?.user) {
      navigate({ to: "/profile" });
    }
  }, [session, isPending, navigate]);

  // Don't show login form if already authenticated
  if (session?.user) {
    return null;
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm />
      </div>
    </div>
  );
}
