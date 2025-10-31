# Database Querying

Fragno provides a unified database query API that works across different ORMs. This guide covers
CRUD operations and querying with conditions.

```typescript @fragno-imports
import { defineFragnoDatabase, schema, idColumn, column } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db";
```

```typescript @fragno-init
// Example schema for testing
const userSchema = schema((s) => {
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
declare const orm: AbstractQuery<UserSchema>;
```

## Create

Create a single record in the database.

```typescript
export async function createUser() {
  const userId = await orm.create("users", {
    id: "user-123",
    email: "john@example.com",
    name: "John Doe",
    age: 30,
  });

  return userId; // Returns a FragnoId object
}
```

The `create` method returns a `FragnoId` object representing the created record's ID.

## Create Many

Create multiple records at once.

```typescript
export async function createMultipleUsers() {
  const userIds = await orm.createMany("users", [
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

  return userIds; // Returns an array of FragnoId objects
}
```

## Find First

Query for a single record using an index.

```typescript
export async function findUserByEmail(email: string) {
  const user = await orm.findFirst("users", (b) =>
    b.whereIndex("idx_email", (eb) => eb("email", "=", email)),
  );

  return user; // Returns the user object or null if not found
}
```

Use `findFirst` when you expect a single result or want to get the first matching record.

## Find First with Select

Query a single record and select specific columns.

```typescript
export async function findUserEmailOnly(userId: string) {
  const user = await orm.findFirst("users", (b) =>
    b.whereIndex("primary", (eb) => eb("id", "=", userId)).select(["id", "email"]),
  );

  return user; // Returns only id and email fields
}
```

## Find Many

Query for multiple records matching conditions.

```typescript
export async function findPostsByAuthor(authorId: string) {
  const posts = await orm.find("posts", (b) =>
    b.whereIndex("idx_author", (eb) => eb("authorId", "=", authorId)),
  );

  return posts; // Returns an array of posts
}
```

The `find` method returns all records matching the where clause.

## Find with Pagination

Limit the number of results returned.

```typescript
export async function findUsersPaginated(page: number, pageSize: number) {
  const users = await orm.find("users", (b) => b.whereIndex("primary").pageSize(pageSize));

  return users;
}
```

## Find All

Query all records from a table.

```typescript
export async function findAllUsers() {
  const users = await orm.find("users", (b) => b.whereIndex("primary"));

  return users;
}
```

When using `whereIndex("primary")` without conditions, it returns all records.

## Update

Update a single record by ID.

```typescript
export async function updateUserEmail(userId: string, newEmail: string) {
  await orm.update("users", userId, (b) =>
    b.set({
      email: newEmail,
    }),
  );
}
```

The `update` method modifies a single record identified by its ID.

## Update Many

Update multiple records matching a condition.

```typescript
export async function updatePostsPublishedDate(authorId: string, publishedAt: Date) {
  await orm.updateMany("posts", (b) =>
    b.whereIndex("idx_author", (eb) => eb("authorId", "=", authorId)).set({ publishedAt }),
  );
}
```

`updateMany` finds all matching records and updates them.

## Delete

Delete a single record by ID.

```typescript
export async function deleteUser(userId: string) {
  await orm.delete("users", userId);
}
```

## Delete Many

Delete multiple records matching a condition.

```typescript
export async function deletePostsByAuthor(authorId: string) {
  await orm.deleteMany("posts", (b) =>
    b.whereIndex("idx_author", (eb) => eb("authorId", "=", authorId)),
  );
}
```

`deleteMany` finds all matching records and deletes them.

## Querying with Conditions

Use condition builders to create complex queries.

```typescript
export async function findAdultUsers() {
  const adults = await orm.find("users", (b) =>
    b.whereIndex("primary").where((cb) => {
      // Note: Condition builders depend on the underlying ORM
      // This is a simplified example
      return cb;
    }),
  );

  return adults;
}
```

Condition builders allow you to add additional filtering beyond index lookups, though the exact API
depends on your adapter (Kysely or Drizzle).
