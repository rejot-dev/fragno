import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="container mx-auto p-8">
      <h1 className="mb-8 text-3xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Link
          to="/profile"
          className="rounded-lg border bg-white p-6 transition-shadow hover:shadow-lg"
        >
          <h2 className="mb-2 text-xl font-semibold">Profile</h2>
          <p className="text-gray-600">Manage your profile settings</p>
        </Link>

        <Link
          to="/users"
          className="rounded-lg border bg-white p-6 transition-shadow hover:shadow-lg"
        >
          <h2 className="mb-2 text-xl font-semibold">Users</h2>
          <p className="text-gray-600">View and manage users</p>
        </Link>

        <Link
          to="/stripe"
          className="rounded-lg border bg-white p-6 transition-shadow hover:shadow-lg"
        >
          <h2 className="mb-2 text-xl font-semibold">Stripe</h2>
          <p className="text-gray-600">Payment integration</p>
        </Link>

        <Link
          to="/plans"
          className="rounded-lg border bg-white p-6 transition-shadow hover:shadow-lg"
        >
          <h2 className="mb-2 text-xl font-semibold">Plans</h2>
          <p className="text-gray-600">Manage subscription plans</p>
        </Link>
      </div>
    </div>
  );
}
