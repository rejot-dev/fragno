import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { stripeClient } from "@/lib/stripe.client";
import { formatDate } from "@/lib/dates";

export function StripeCustomers() {
  const [customerPage, setCustomerPage] = useState<string | undefined>(undefined);
  const [customerHistory, setCustomerHistory] = useState<string[]>([]);

  const {
    data: customersData,
    loading: customersLoading,
    error: customersError,
  } = stripeClient.useCustomers({
    query: {
      limit: "10",
      startingAfter: customerPage,
    },
  });

  const handleNextCustomerPage = () => {
    if (customersData?.customers && customersData.customers.length > 0) {
      const lastCustomerId = customersData.customers[customersData.customers.length - 1]?.id;
      if (lastCustomerId) {
        setCustomerHistory((prev) => [...prev, customerPage].filter(Boolean) as string[]);
        setCustomerPage(lastCustomerId);
      }
    }
  };

  const handlePreviousCustomerPage = () => {
    if (customerHistory.length > 0) {
      const previousPage = customerHistory[customerHistory.length - 1];
      setCustomerHistory((prev) => prev.slice(0, -1));
      setCustomerPage(previousPage);
    } else {
      setCustomerPage(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stripe Customers</CardTitle>
        <CardDescription>View all Stripe customers from your account</CardDescription>
      </CardHeader>
      <CardContent>
        {customersLoading ? (
          <div className="text-muted-foreground py-8 text-center">Loading customers...</div>
        ) : customersError ? (
          <div className="py-8 text-center text-red-600">
            Failed to load customers: {customersError.message}
          </div>
        ) : !customersData || customersData.customers.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">No customers found.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer ID</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>User ID</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customersData.customers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell>
                      <span className="font-mono text-xs">{customer.id}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{customer.email || "?"}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{customer.name || "?"}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">
                        {customer.metadata["referenceId"] || customer.metadata["userId"] || "?"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(customer.created * 1000)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {customersData && customersData.customers.length > 0 && (
              <div className="mt-4 flex items-center justify-between">
                <div className="text-muted-foreground text-sm">
                  Showing {customersData.customers.length} customers
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePreviousCustomerPage}
                    disabled={customerHistory.length === 0 && !customerPage}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleNextCustomerPage}
                    disabled={!customersData.hasMore}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
