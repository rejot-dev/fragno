import { Link, useNavigate } from "@tanstack/react-router";
import { useSession, signOut } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

export default function Header() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <header className="flex items-center justify-between bg-gray-800 p-4 text-white shadow-lg">
      <h1 className="text-xl font-semibold">
        <Link to="/">Stripe Webshop</Link>
      </h1>

      <div className="flex items-center gap-4">
        {session?.user ? (
          <>
            <Link
              to="/profile"
              className="text-sm hover:underline"
              activeProps={{
                className: "underline font-semibold",
              }}
            >
              {session.user.name}
            </Link>
            <Button variant="outline" size="sm" onClick={handleSignOut} className="text-gray-900">
              Sign Out
            </Button>
          </>
        ) : null}
      </div>
    </header>
  );
}
