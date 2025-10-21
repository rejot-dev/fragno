import { createFileRoute } from "@tanstack/react-router";
import { db } from "@/db";
import { products } from "@/db/schema";

export const Route = createFileRoute("/api/products")({
  server: {
    handlers: {
      GET: async () => {
        const allProducts = await db.select().from(products);
        return Response.json(allProducts);
      },
    },
  },
});
