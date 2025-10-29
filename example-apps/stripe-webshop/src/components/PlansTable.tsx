import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PLANS } from "@/lib/plans";

export function PlansTable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans Overview</CardTitle>
        <CardDescription>View all available subscription plans</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Display Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Monthly Price</TableHead>
                <TableHead>Yearly Price</TableHead>
                <TableHead>Stripe Product ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PLANS.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell>
                    <span className="font-mono text-sm">{plan.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{plan.displayName}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{plan.description}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {plan.priceMonthly === 0 ? "Free" : `$${plan.priceMonthly / 100}`}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {plan.priceYearly === 0 ? "Free" : `$${plan.priceYearly / 100}`}
                    </span>
                  </TableCell>
                  <TableCell>
                    {plan.stripeProductId ? (
                      <span className="font-mono text-xs">
                        {plan.stripeProductId.slice(0, 16)}...
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
