import { createFileRoute } from "@tanstack/react-router";
import { UsersTable } from "@/components/UsersTable";

export const Route = createFileRoute("/_authenticated/users")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="flex min-h-svh w-full flex-col items-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-7xl space-y-6">
        <UsersTable />
      </div>
    </div>
  );
}
