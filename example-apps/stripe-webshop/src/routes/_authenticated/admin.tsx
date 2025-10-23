import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { StripeCustomers } from "@/components/StripeCustomers";
import { stripeClient } from "@/lib/stripe.client";

export const Route = createFileRoute("/_authenticated/admin")({
  component: RouteComponent,
});

function RouteComponent() {
  const { data, loading, error } = stripeClient.useSubscription();

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) {
      return "—";
    }
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "text-green-600";
      case "trialing":
        return "text-blue-600";
      case "incomplete":
        return "text-amber-600";
      case "canceled":
      case "incomplete_expired":
        return "text-red-600";
      case "past_due":
        return "text-orange-600";
      default:
        return "text-gray-600";
    }
  };

  return (
    <div className="flex min-h-svh w-full flex-col items-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-7xl space-y-6">
        <StripeCustomers />

        <Card>
          <CardHeader>
            <CardTitle>Subscription Overview</CardTitle>
            <CardDescription>Manage and view all customer subscriptions</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-muted-foreground py-8 text-center">Loading subscriptions...</div>
            ) : error ? (
              <div className="py-8 text-center text-red-600">
                Failed to load subscriptions. Please try again later.
              </div>
            ) : !data || !data.subscriptions || data.subscriptions.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center">No subscriptions found.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Stripe ID</TableHead>
                      <TableHead>Seats</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.subscriptions.map((sub) => (
                      <TableRow key={sub.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-xs font-medium">
                              {sub.stripeCustomerId || "—"}
                            </span>
                            <span className="text-muted-foreground text-xs">Customer ID</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-sm">{sub.plan}</span>
                        </TableCell>
                        <TableCell>
                          <span className={`font-medium ${getStatusColor(sub.status)}`}>
                            {sub.status}
                          </span>
                          {sub.cancelAtPeriodEnd && (
                            <span className="text-muted-foreground ml-2 text-xs">(canceling)</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col text-sm">
                            <span>{formatDate(sub.periodStart)}</span>
                            <span className="text-muted-foreground text-xs">
                              to {formatDate(sub.periodEnd)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {sub.stripeSubscriptionId ? (
                            <span className="font-mono text-xs">
                              {sub.stripeSubscriptionId.slice(0, 16)}...
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {sub.seats ? (
                            <span>{sub.seats}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDate(sub.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
