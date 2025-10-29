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

export function StripeProducts() {
  const [productPage, setProductPage] = useState<string | undefined>(undefined);
  const [productHistory, setProductHistory] = useState<string[]>([]);

  const {
    data: productsData,
    loading: productsLoading,
    error: productsError,
  } = stripeClient.useProducts({
    query: {
      limit: "10",
      startingAfter: productPage || "",
    },
  });

  const handleNextProductPage = () => {
    if (productsData?.products && productsData.products.length > 0) {
      const lastProductId = productsData.products[productsData.products.length - 1]?.id;
      if (lastProductId) {
        setProductHistory((prev) => [...prev, productPage].filter(Boolean) as string[]);
        setProductPage(lastProductId);
      }
    }
  };

  const handlePreviousProductPage = () => {
    if (productHistory.length > 0) {
      const previousPage = productHistory[productHistory.length - 1];
      setProductHistory((prev) => prev.slice(0, -1));
      setProductPage(previousPage);
    } else {
      setProductPage(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stripe Products</CardTitle>
        <CardDescription>View all Stripe products from your account</CardDescription>
      </CardHeader>
      <CardContent>
        {productsLoading ? (
          <div className="text-muted-foreground py-8 text-center">Loading products...</div>
        ) : productsError ? (
          <div className="py-8 text-center text-red-600">
            Failed to load products: {productsError.message}
          </div>
        ) : !productsData || productsData.products.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">No products found.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productsData.products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell>
                      <span className="font-mono text-xs">{product.id.slice(0, 16)}...</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{product.name}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{product.description || "—"}</span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`text-sm font-medium ${product.active ? "text-green-600" : "text-gray-400"}`}
                      >
                        {product.active ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(product.created * 1000)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {productsData && productsData.products.length > 0 && (
              <div className="mt-4 flex items-center justify-between">
                <div className="text-muted-foreground text-sm">
                  Showing {productsData.products.length} products
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePreviousProductPage}
                    disabled={productHistory.length === 0 && !productPage}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleNextProductPage}
                    disabled={!productsData.hasMore}
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
