import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { type Cursor, decodeCursor } from "@fragno-dev/db/cursor";
import { authSchema } from "../schema";
import { z } from "zod";
import type { authFragmentDefinition } from "..";

export type SortField = "email" | "createdAt";
export type SortOrder = "asc" | "desc";

export interface GetUsersParams {
  search?: string;
  sortBy: SortField;
  sortOrder: SortOrder;
  pageSize: number;
  cursor?: Cursor;
}

export interface UserResult {
  id: string;
  email: string;
  role: "user" | "admin";
  createdAt: Date;
}

export function createUserOverviewServices(db: SimpleQueryInterface<typeof authSchema>) {
  const mapUser = (user: {
    id: unknown;
    email: string;
    role: string;
    createdAt: Date;
  }): UserResult => ({
    id: String(user.id),
    email: user.email,
    role: user.role as "user" | "admin",
    createdAt: user.createdAt,
  });

  return {
    getUsersWithCursor: async (params: GetUsersParams) => {
      const { search, sortBy, sortOrder, pageSize, cursor } = params;

      // Determine which index to use based on search and sortBy
      // When searching, only email sorting is allowed (search uses email index)
      const effectiveSortBy: SortField = search ? "email" : sortBy;
      const indexName = effectiveSortBy === "email" ? "idx_user_email" : "idx_user_createdAt";

      // If cursor is provided, extract its metadata to ensure consistency
      const effectiveSortOrder = cursor ? cursor.orderDirection : sortOrder;
      const effectivePageSize = cursor ? cursor.pageSize : pageSize;

      const result = await db.findWithCursor("user", (b) => {
        // When searching, we must filter by email and can only use the email index
        if (search) {
          const query = b
            .whereIndex("idx_user_email", (eb) => eb("email", "contains", search))
            .orderByIndex("idx_user_email", effectiveSortOrder)
            .pageSize(effectivePageSize);

          // Add cursor for pagination continuation
          return cursor ? query.after(cursor) : query;
        }

        // When not searching, use the appropriate index for sorting
        const query = b
          .whereIndex(indexName)
          .orderByIndex(indexName, effectiveSortOrder)
          .pageSize(effectivePageSize);

        // Add cursor for pagination continuation
        return cursor ? query.after(cursor) : query;
      });

      return {
        users: result.items.map(mapUser),
        cursor: result.cursor,
        hasNextPage: result.hasNextPage,
      };
    },
  };
}

const sortBySchema = z.enum(["email", "createdAt"]);

export const userOverviewRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services }) => {
    const parseQueryParams = (query: URLSearchParams) => {
      const search = query.get("search") || undefined;
      const requestedSortBy = (query.get("sortBy") || "createdAt") as SortField;
      const sortOrder = (query.get("sortOrder") || "desc") as SortOrder;
      const pageSize = Math.min(Math.max(Number(query.get("pageSize")) || 20, 1), 100);

      // When searching, enforce email sorting for efficient queries
      const sortBy: SortField = search ? "email" : requestedSortBy;

      return { search, sortBy, sortOrder, pageSize };
    };

    const parseCursor = (cursorParam: string | null): Cursor | undefined => {
      if (!cursorParam) {
        return undefined;
      }
      try {
        return decodeCursor(cursorParam);
      } catch {
        return undefined;
      }
    };

    return [
      defineRoute({
        method: "GET",
        path: "/users",
        queryParameters: ["search", "sortBy", "sortOrder", "pageSize", "cursor"],
        outputSchema: z.object({
          users: z.array(
            z.object({
              id: z.string(),
              email: z.string(),
              role: z.enum(["user", "admin"]),
              createdAt: z.string(),
            }),
          ),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
          sortBy: sortBySchema,
        }),
        errorCodes: ["invalid_input"],
        handler: async ({ query }, { json }) => {
          const params = parseQueryParams(query);
          const cursor = parseCursor(query.get("cursor"));

          const result = await services.getUsersWithCursor({
            ...params,
            cursor,
          });

          return json({
            users: result.users.map((user) => ({
              id: user.id,
              email: user.email,
              role: user.role,
              createdAt: user.createdAt.toISOString(),
            })),
            cursor: result.cursor?.encode(),
            hasNextPage: result.hasNextPage,
            sortBy: params.sortBy, // Return the actual sortBy used (may differ from requested)
          });
        },
      }),
    ];
  },
);
