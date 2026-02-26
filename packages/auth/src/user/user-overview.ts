import { defineRoute, defineRoutes } from "@fragno-dev/core";
import type { DatabaseServiceContext } from "@fragno-dev/db";
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

type AuthServiceContext = DatabaseServiceContext<{}>;

export function createUserOverviewServices() {
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
    /**
     * List users with cursor-based pagination, optional search, and sorting.
     */
    getUsersWithCursor: function (this: AuthServiceContext, params: GetUsersParams) {
      const { search, sortBy, sortOrder, pageSize, cursor } = params;

      // Determine which index to use based on search and sortBy
      // When searching, only email sorting is allowed (search uses email index)
      const effectiveSortBy: SortField = search ? "email" : sortBy;
      const indexName = effectiveSortBy === "email" ? "idx_user_email" : "idx_user_createdAt";

      // If cursor is provided, extract its metadata to ensure consistency
      const effectiveSortOrder = cursor ? cursor.orderDirection : sortOrder;
      const effectivePageSize = cursor ? cursor.pageSize : pageSize;

      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findWithCursor("user", (b) => {
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
          }),
        )
        .transformRetrieve(([result]) => ({
          users: result.items.map(mapUser),
          cursor: result.cursor,
          hasNextPage: result.hasNextPage,
        }))
        .build();
    },
  };
}

const sortBySchema = z.enum(["email", "createdAt"]);
const sortOrderSchema = z.enum(["asc", "desc"]);

export const userOverviewRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services }) => {
    const querySchema = z.object({
      search: z.string().optional(),
      sortBy: sortBySchema.default("createdAt"),
      sortOrder: sortOrderSchema.default("desc"),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    });

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
        handler: async function ({ query }, { json, error }) {
          const parsed = querySchema.safeParse(Object.fromEntries(query.entries()));
          if (!parsed.success) {
            return error({ message: "Invalid query parameters", code: "invalid_input" }, 400);
          }

          const rawSearch = parsed.data.search?.trim();
          const search = rawSearch ? rawSearch : undefined;
          const sortBy: SortField = search ? "email" : parsed.data.sortBy;
          const params = {
            search,
            sortBy,
            sortOrder: parsed.data.sortOrder as SortOrder,
            pageSize: parsed.data.pageSize,
          };
          const cursor = parseCursor(query.get("cursor"));

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.getUsersWithCursor({ ...params, cursor })])
            .execute();

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
