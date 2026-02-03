# Database Querying

Fragno provides a unified database query API that works across different ORMs. This guide covers
CRUD operations and querying with conditions.

```typescript @fragno-imports
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { schema, idColumn, column } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
```

```typescript @fragno-prelude:schema
// Example schema for testing
const userSchema = schema("user", (s) => {
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("name", column("string"))
        .addColumn("age", column("integer").nullable())
        .createIndex("idx_email", ["email"], { unique: true });
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("authorId", column("string"))
        .addColumn("publishedAt", column("timestamp").nullable())
        .createIndex("idx_author", ["authorId"]);
    });
});

type UserSchema = typeof userSchema;
```

```typescript @fragno-test-init
// Create a test fragment with database
const testFragmentDef = defineFragment<{}>("test-fragment")
  .extend(withDatabase(userSchema))
  .providesBaseService(() => ({}))
  .build();

const { fragments, test } = await buildDatabaseFragmentsTest()
  .withTestAdapter({ type: "kysely-sqlite" })
  .withFragment("test", instantiate(testFragmentDef).withConfig({}).withRoutes([]))
  .build();

const db = fragments.test.db;
```

## Create

Create a single record in the database.

```typescript @fragno-test:create-user
// should create a single user
const userId = await db.create("users", {
  id: "user-123",
  email: "john@example.com",
  name: "John Doe",
  age: 30,
});

expect(userId).toBeDefined();
expect(userId.valueOf()).toBe("user-123");
```

The `create` method returns a `FragnoId` object representing the created record's ID.

## Create Many

Create multiple records at once.

```typescript @fragno-test:create-many
// should create multiple users at once
const userIds = await db.createMany("users", [
  {
    id: "user-1",
    email: "user1@example.com",
    name: "User One",
    age: 25,
  },
  {
    id: "user-2",
    email: "user2@example.com",
    name: "User Two",
    age: 35,
  },
]);

expect(userIds).toHaveLength(2);
expect(userIds[0].valueOf()).toBe("user-1");
expect(userIds[1].valueOf()).toBe("user-2");
```

## Find First

Query for a single record using an index.

```typescript @fragno-test:find-user-by-email
// should find user by email using index
await db.create("users", {
  id: "user-find-1",
  email: "findme@example.com",
  name: "Find Me",
  age: 28,
});

const user = await db.findFirst("users", (b) =>
  b.whereIndex("idx_email", (eb) => eb("email", "=", "findme@example.com")),
);

expect(user).toBeDefined();
expect(user?.email).toBe("findme@example.com");
expect(user?.name).toBe("Find Me");
```

Use `findFirst` when you expect a single result or want to get the first matching record.

## Find First with Select

Query a single record and select specific columns.

```typescript @fragno-test:find-user-select
export async function findUserEmailOnly(userId: string) {
  const user = await db.findFirst("users", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", userId)).select(["id", "email"]),
  );

  return user; // Returns only id and email fields
}
```

## Find Many

Query for multiple records matching conditions.

```typescript @fragno-test:find-many
// should find multiple posts by author
await db.createMany("posts", [
  {
    id: "post-1",
    title: "First Post",
    content: "Content 1",
    authorId: "author-123",
    publishedAt: null,
  },
  {
    id: "post-2",
    title: "Second Post",
    content: "Content 2",
    authorId: "author-123",
    publishedAt: null,
  },
  {
    id: "post-3",
    title: "Other Post",
    content: "Content 3",
    authorId: "author-456",
    publishedAt: null,
  },
]);

const posts = await db.find("posts", (b) =>
  b.whereIndex("idx_author", (eb) => eb("authorId", "=", "author-123")),
);

expect(posts).toHaveLength(2);
expect(posts[0].authorId).toBe("author-123");
expect(posts[1].authorId).toBe("author-123");
```

The `find` method returns all records matching the where clause.

## Find with Pagination

Limit the number of results returned.

```typescript @fragno-test:find-paginated
export async function findUsersPaginated(pageSize: number) {
  const users = await db.find("users", (b) => b.whereIndex("primary").pageSize(pageSize));

  return users;
}
```

## Cursor-Based Pagination

Use `findWithCursor` for efficient pagination with cursor support.

```typescript @fragno-test:cursor-pagination
const firstPage = await db.findWithCursor("users", (b) =>
  b.whereIndex("idx_email").orderByIndex("idx_email", "asc").pageSize(2),
);

const cursor = firstPage.cursor;
if (cursor) {
  const nextPage = await db.findWithCursor("users", (b) => b.after(cursor));
}
```

The `findWithCursor` method returns a `CursorResult` object containing:

- `items`: The array of results for the current page
- `cursor`: A `Cursor` object for fetching the next page (undefined if no more results)

The cursor automatically stores pagination metadata (index, ordering, page size), so you can simply
pass it to `b.after()` for the next page.

## Find All

Query all records from a table.

```typescript @fragno-test:find-all
export async function findAllUsers() {
  const users = await db.find("users", (b) => b.whereIndex("primary"));

  return users;
}
```

When using `whereIndex("primary")` without conditions, it returns all records.

## Update

Update a single record by ID.

```typescript @fragno-test:update-user
// should update a user's email
await db.create("users", {
  id: "user-update-1",
  email: "old@example.com",
  name: "Update Test",
  age: 30,
});

await db.update("users", "user-update-1", (b) =>
  b.set({
    email: "new@example.com",
  }),
);

const updatedUser = await db.findFirst("users", (b) =>
  b.whereIndex("primary", (eb) => eb("id", "=", "user-update-1")),
);

expect(updatedUser?.email).toBe("new@example.com");
expect(updatedUser?.name).toBe("Update Test");
```

The `update` method modifies a single record identified by its ID.

## Update Many

Update multiple records matching a condition.

```typescript @fragno-test:update-many
export async function updatePostsPublishedDate(authorId: string, publishedAt: Date) {
  await db.updateMany("posts", (b) =>
    b.whereIndex("idx_author", (eb) => eb("authorId", "=", authorId)).set({ publishedAt }),
  );
}
```

`updateMany` finds all matching records and updates them.

## Delete

Delete a single record by ID.

```typescript @fragno-test:delete-user
// should delete a user by ID
await db.create("users", {
  id: "user-delete-1",
  email: "delete@example.com",
  name: "Delete Me",
  age: 25,
});

await db.delete("users", "user-delete-1");

const deletedUser = await db.findFirst("users", (b) =>
  b.whereIndex("primary", (eb) => eb("id", "=", "user-delete-1")),
);

expect(deletedUser).toBeNull();
```

## Delete Many

Delete multiple records matching a condition.

```typescript @fragno-test:delete-many
export async function deletePostsByAuthor(authorId: string) {
  await db.deleteMany("posts", (b) =>
    b.whereIndex("idx_author", (eb) => eb("authorId", "=", authorId)),
  );
}
```

`deleteMany` finds all matching records and deletes them.

## Querying with Conditions

Use expression builders within `whereIndex()` to create queries with conditions.

```typescript @fragno-test:query-conditions
const user = await db.findFirst("users", (b) =>
  b.whereIndex("idx_email", (eb) => eb("email", "=", "adult1@example.com")),
);
```

The expression builder (the `eb` parameter) is used within the `whereIndex()` callback to specify
conditions on indexed columns.
