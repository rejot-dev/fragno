import { describe, expect, test, assert } from "vitest";

import { readOrganizationMemberNumberedPage } from "./directory-queries";

type Row = Record<string, unknown> & { id: string };
type Where = { field: string; value: unknown; operator?: string };

/**
 * An adapter over `tables` that finds rows as Better Auth's does, including returning 100 rows
 * when a query sets no limit.
 */
function betterAuthLikeAdapter(tables: Record<string, Row[]>) {
  const matching = (model: string, where: readonly Where[] = []) =>
    (tables[model] ?? []).filter((row) =>
      where.every(({ field, value, operator }) =>
        operator === "in" ? (value as unknown[]).includes(row[field]) : row[field] === value,
      ),
    );
  return {
    async findMany({
      model,
      where,
      limit,
      offset,
    }: {
      model: string;
      where?: Where[];
      limit?: number;
      offset?: number;
    }) {
      const start = offset ?? 0;
      return matching(model, where).slice(start, start + (limit ?? 100));
    },
    async count({ model, where }: { model: string; where?: Where[] }) {
      return matching(model, where).length;
    },
  };
}

describe("an organization's numbered member pages", () => {
  test("name every member on a page longer than the adapter's default limit", async () => {
    const users = Array.from({ length: 150 }, (_, index) => ({
      id: `user-${index}`,
      name: `Member ${index}`,
      email: `member-${index}@example.com`,
    }));
    const adapter = betterAuthLikeAdapter({
      user: users,
      member: users.map(({ id }, index) => ({
        id: `member-${index}`,
        organizationId: "org-1",
        userId: id,
        role: "member",
        createdAt: new Date(index),
      })),
    });

    const page = await readOrganizationMemberNumberedPage(adapter as never, {
      organizationId: "org-1",
      page: 1,
      pageSize: 150,
    });

    assert(page.total === 150);
    expect(page.members.map(({ name }) => name)).toEqual(users.map(({ name }) => name));
  });
});
