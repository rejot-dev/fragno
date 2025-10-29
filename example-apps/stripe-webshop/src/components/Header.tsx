import { Link, useNavigate } from "@tanstack/react-router";
import { useSession, signOut } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

export default function Header() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/" });
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
            <div className="flex items-center gap-1 rounded-lg bg-gray-700/50 px-3 py-1.5 ring-1 ring-gray-600/50">
              <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
                Admin
              </span>
              <div className="mx-1 h-4 w-px bg-gray-600"></div>
              <Link
                to="/users"
                className="rounded px-2 py-1 text-sm transition-colors hover:bg-gray-600/50"
                activeProps={{
                  className: "bg-gray-600 font-semibold",
                }}
              >
                Users
              </Link>
              <Link
                to="/stripe"
                className="rounded px-2 py-1 text-sm transition-colors hover:bg-gray-600/50"
                activeProps={{
                  className: "bg-gray-600 font-semibold",
                }}
              >
                Stripe
              </Link>
              <Link
                to="/plans"
                className="rounded px-2 py-1 text-sm transition-colors hover:bg-gray-600/50"
                activeProps={{
                  className: "bg-gray-600 font-semibold",
                }}
              >
                Plans
              </Link>
            </div>
            <Button variant="outline" size="sm" onClick={handleSignOut} className="text-gray-900">
              Sign Out
            </Button>
          </>
        ) : (
          <Link to="/login" search={{ redirect: undefined }} className="text-gray-900">
            <Button variant="outline" size="sm">
              Sign In
            </Button>
          </Link>
        )}
      </div>
    </header>
  );
}
