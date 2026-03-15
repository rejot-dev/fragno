import { useEffect } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SignupForm } from "@/components/signup-form";
import { useSession } from "@/lib/auth/client";

export const Route = createFileRoute("/signup")({
  component: SignupPage,
});

function SignupPage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    // If already authenticated, redirect to profile
    if (!isPending && session?.user) {
      navigate({ to: "/profile" });
    }
  }, [session, isPending, navigate]);

  // Don't show signup form if already authenticated
  if (session?.user) {
    return null;
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <SignupForm />
      </div>
    </div>
  );
}
