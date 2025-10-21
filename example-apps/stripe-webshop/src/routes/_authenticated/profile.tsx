import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signOut, useSession } from "@/lib/auth/client";

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const { data: session } = useSession();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  const formatDate = (date: Date | number) => {
    const dateObj = typeof date === "number" ? new Date(date) : date;
    return dateObj.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  // Safety check - should be protected by _authenticated layout
  if (!session?.user) {
    return null;
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>User Profile</CardTitle>
            <CardDescription>Manage your account information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <label className="text-muted-foreground text-sm font-medium">Name</label>
                <p className="text-lg font-semibold">{session.user.name}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Email</label>
                <p className="text-lg">{session.user.email}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Email Verified</label>
                <p className="text-lg">
                  {session.user.emailVerified ? (
                    <span className="text-green-600">✓ Verified</span>
                  ) : (
                    <span className="text-amber-600">Not verified</span>
                  )}
                </p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Account Created</label>
                <p className="text-lg">{formatDate(session.user.createdAt)}</p>
              </div>
            </div>

            <div className="flex gap-4 pt-4">
              <Button variant="destructive" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
