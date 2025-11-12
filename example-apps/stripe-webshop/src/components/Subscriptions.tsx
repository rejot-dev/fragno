import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { stripeClient } from "@/lib/stripe.client";

export function Subscriptions() {
  const { data, loading, error } = stripeClient.useSubscription();

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
    <Card>
      <CardHeader>
        <CardTitle>Subscriptions</CardTitle>
        <CardDescription>View all subscriptions as they are in the DB</CardDescription>
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
                  <TableHead>Status</TableHead>
                  <TableHead>PriceID</TableHead>
                  <TableHead>Stripe ID</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">{sub.stripeCustomerId || "—"}</span>
                        <span className="text-muted-foreground text-xs">Customer ID</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`font-medium ${getStatusColor(sub.status)}`}>
                        {sub.status}
                      </span>
                      {sub.cancelAt && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          (cancels {formatDate(sub.cancelAt)})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{sub.stripePriceId}</TableCell>
                    <TableCell>
                      {sub.stripeSubscriptionId ? (
                        <span className="font-mono text-xs">{sub.stripeSubscriptionId}</span>
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
  );
}
