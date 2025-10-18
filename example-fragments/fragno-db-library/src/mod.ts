import { createFragnoDatabase } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db/query";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const userSchema = schema((s) => {
  return s
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("userId", referenceColumn());
    })
    .addTable("users", (t) => {
      return t.addColumn("id", idColumn()).addColumn("name", column("string"));
    })
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "userId" },
      to: { table: "users", column: "id" },
    });
});

export const fragnoDatabaseLibrary = createFragnoDatabase({
  namespace: "fragno-db-test-library",
  schema: userSchema,
});

export function createFragnoDatabaseLibrary(orm: AbstractQuery<typeof userSchema>) {
  const internal = {
    createUser: (user: { name: string }) => {
      return orm.create("users", user);
    },
    createPost: (post: { title: string; content: string; userId: string }) => {
      return orm.create("posts", post);
    },
    getPosts: () => {
      return orm.find("posts", (b) =>
        b
          .whereIndex("primary")
          .select(["id", "title", "content"])
          .join((jb) => jb.author()),
      );
    },
  };

  return {
    createUserAndPost: async (u: { name: string }, p: { title: string; content: string }) => {
      const user = await internal.createUser(u);
      console.log(user);
      const post = await internal.createPost({ ...p, userId: user.toString() });
      return { user, post };
    },
    getPosts: internal.getPosts,
  };
}
