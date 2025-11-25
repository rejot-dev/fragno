import type { BlogPostUpdate, NewBlogPost, NewUser, User, UserUpdate } from "./kysely-types";
import { db } from "./database";
import { sql } from "kysely";

// User repository methods
export async function findUserById(id: number) {
  return await db.selectFrom("user").where("id", "=", id).selectAll().executeTakeFirst();
}

export async function findUserByEmail(email: string) {
  return await db.selectFrom("user").where("email", "=", email).selectAll().executeTakeFirst();
}

export async function findUsers(criteria: Partial<User>) {
  let query = db.selectFrom("user");

  if (criteria.id) {
    query = query.where("id", "=", criteria.id);
  }

  if (criteria.email) {
    query = query.where("email", "=", criteria.email);
  }

  if (criteria.name) {
    query = query.where("name", "=", criteria.name);
  }

  if (criteria.created_at) {
    query = query.where("created_at", "=", criteria.created_at);
  }

  return await query.selectAll().execute();
}

export async function createUser(user: NewUser): Promise<User> {
  return await db.insertInto("user").values(user).returningAll().executeTakeFirstOrThrow();
}

export async function updateUser(id: number, updateWith: UserUpdate) {
  await db.updateTable("user").set(updateWith).where("id", "=", id).execute();
}

export async function deleteUser(id: number) {
  return await db.deleteFrom("user").where("id", "=", id).returningAll().executeTakeFirst();
}

// BlogPost repository methods
export async function findBlogPostById(id: number) {
  return await db.selectFrom("blog_post").where("id", "=", id).selectAll().executeTakeFirst();
}

export async function findBlogPostsByAuthor(authorId: number) {
  return await db
    .selectFrom("blog_post")
    .where("author_id", "=", authorId)
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
}

export async function findAllBlogPosts() {
  return await db.selectFrom("blog_post").selectAll().orderBy("created_at", "desc").execute();
}

export async function findBlogPostsWithAuthor() {
  return await db
    .selectFrom("blog_post")
    .innerJoin("user", "user.id", "blog_post.author_id")
    .innerJoin("comment_fragno-db-comment", (join) =>
      join.onRef(
        sql.ref("comment_fragno-db-comment.postReference"),
        "=",
        sql.raw("blog_post.id::text"),
      ),
    )
    .leftJoin("upvote_total_fragno-db-rating", (join) =>
      join.onRef(
        sql.ref("upvote_total_fragno-db-rating.reference"),
        "=",
        sql.raw("blog_post.id::text"),
      ),
    )
    .select([
      "blog_post.id",
      "blog_post.title",
      "blog_post.content",
      "blog_post.created_at",
      "blog_post.updated_at",
      "user.id as author_id",
      "user.name as author_name",
      "user.email as author_email",
      sql<unknown>`json_agg(${sql.table("comment_fragno-db-comment")})`.as("comments"),
      sql<number>`COALESCE(${sql.ref("upvote_total_fragno-db-rating.total")}, 0)`.as("rating"),
    ])
    .groupBy(["blog_post.id", "user.id", sql.ref("upvote_total_fragno-db-rating.total")])
    .orderBy("blog_post.created_at", "desc")
    .execute();
}

export async function createBlogPost(post: NewBlogPost) {
  return await db.insertInto("blog_post").values(post).returningAll().executeTakeFirstOrThrow();
}

export async function updateBlogPost(id: number, updateWith: BlogPostUpdate) {
  await db.updateTable("blog_post").set(updateWith).where("id", "=", id).execute();
}

export async function deleteBlogPost(id: number) {
  return await db.deleteFrom("blog_post").where("id", "=", id).returningAll().executeTakeFirst();
}

export async function searchBlogPostsByTitle(searchTerm: string) {
  return await db
    .selectFrom("blog_post")
    .where("title", "like", `%${searchTerm}%`)
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
}
